import datetime as dt
import io
import os
import sys
import unittest
from unittest.mock import patch
import urllib.error

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import sync_vigicrues_backup as sync

NOW = dt.datetime(2026,11,15,14,0,tzinfo=dt.timezone.utc)
TIME = int(NOW.timestamp()*1000)
STATION_A = 'Y531201001'
STATION_B = 'A123456789'

def sample(code,latest_minutes=10):
    return {'Serie':{
        'CdStationHydro':code,'GrdSerie':'H',
        'ObssHydro':[
            {'DtObsHydro':TIME-latest_minutes*60000,'ResObsHydro':1.44},
            {'DtObsHydro':TIME-(latest_minutes+35)*60000,'ResObsHydro':1.39},
            {'DtObsHydro':TIME-5*86400000,'ResObsHydro':1.23},
        ]}}

class StationSyncTests(unittest.TestCase):
    def test_stations_are_discovered_instead_of_hardcoded(self):
        with patch.object(sync,'signed_json',return_value={
                'ok':True,'stations':[STATION_A,STATION_B], 'activeCount':2,'deferred':[]}):
            self.assertEqual(sync.active_station_codes('token'),[STATION_A,STATION_B])

    def test_both_stations_get_independent_snapshots_and_old_points_removed(self):
        for code in (STATION_A,STATION_B):
            with patch.object(sync,'http_json',return_value=sample(code)):
                snap=sync.load_vigicrues_station(code,NOW)
                self.assertEqual(snap['station'],code)
                self.assertEqual(snap['readings'][0][1],1440)
                self.assertEqual(len(snap['readings']),2)
                self.assertEqual(snap['collectedAt'],TIME)

    def test_unsupported_station_does_not_create_fake_backup(self):
        with patch.object(sync,'http_json',return_value={'Serie':None}):
            with self.assertRaises(sync.UnusableSeries) as err:
                sync.load_vigicrues_station(STATION_B,NOW)
            self.assertEqual(err.exception.reason,'invalid_series')

    def test_stale_series_is_not_a_valid_backup(self):
        with patch.object(sync,'http_json',return_value=sample(STATION_B,latest_minutes=240)):
            with self.assertRaises(sync.UnusableSeries) as err:
                sync.load_vigicrues_station(STATION_B,NOW)
            self.assertEqual(err.exception.reason,'stale')

    def test_vigicrues_http_404_sets_unavailable_reason(self):
        response=urllib.error.HTTPError('https://www.vigicrues.gouv.fr',404,'Not found',{},None)
        with patch.object(sync,'http_json',side_effect=response):
            with self.assertRaises(sync.UnusableSeries) as err:
                sync.load_vigicrues_station(STATION_B,NOW)
            self.assertEqual(err.exception.reason,'not_found')

    def test_two_network_timeouts_recover_without_false_actions_failure(self):
        timed_out = urllib.error.URLError('timed out')
        with patch.object(sync, 'http_json', side_effect=[
                timed_out, timed_out, sample(STATION_A)] ) as mocked:
            with patch.object(sync.time, 'sleep') as wait:
                snapshot = sync.load_vigicrues_station(STATION_A, NOW)
        self.assertEqual(snapshot['station'], STATION_A)
        self.assertEqual(len(snapshot['readings']), 2)
        self.assertEqual(mocked.call_count, 3)
        self.assertEqual([call.args[0] for call in wait.call_args_list], [2, 5])

    def test_persistent_timeout_still_fails_after_bounded_retries(self):
        transient = urllib.error.URLError('timed out')
        with patch.object(sync, 'http_json', side_effect=transient) as mocked:
            with patch.object(sync.time, 'sleep') as wait:
                with self.assertRaises(urllib.error.URLError):
                    sync.load_vigicrues_station(STATION_A, NOW)
        self.assertEqual(mocked.call_count, 3)
        self.assertEqual(wait.call_count, 2)

    def test_transient_http_503_retries_then_succeeds(self):
        unavailable = urllib.error.HTTPError('https://www.vigicrues.gouv.fr', 503,
                                            'Service Unavailable', {}, None)
        with patch.object(sync, 'http_json', side_effect=[unavailable, sample(STATION_A)]) as mocked:
            with patch.object(sync.time, 'sleep') as wait:
                snapshot = sync.load_vigicrues_station(STATION_A, NOW)
        self.assertEqual(snapshot['station'], STATION_A)
        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(wait.call_args.args, (2,))

    def test_permanent_http_403_remains_unavailable_without_retries(self):
        forbidden = urllib.error.HTTPError('https://www.vigicrues.gouv.fr', 403,
                                           'Forbidden', {}, None)
        with patch.object(sync, 'http_json', side_effect=forbidden) as mocked:
            with patch.object(sync.time, 'sleep') as wait:
                with self.assertRaises(sync.UnusableSeries) as err:
                    sync.load_vigicrues_station(STATION_A, NOW)
        self.assertEqual(err.exception.reason, 'access_denied')
        self.assertEqual(mocked.call_count, 1)
        wait.assert_not_called()

    def test_stale_data_is_never_made_healthy_by_network_retries(self):
        with patch.object(sync, 'http_json', return_value=sample(STATION_A, latest_minutes=240)) as mocked:
            with patch.object(sync.time, 'sleep') as wait:
                with self.assertRaises(sync.UnusableSeries) as err:
                    sync.load_vigicrues_station(STATION_A, NOW)
        self.assertEqual(err.exception.reason, 'stale')
        self.assertEqual(mocked.call_count, 1)
        wait.assert_not_called()

    def test_unsupported_station_reports_cooldown_while_other_station_is_stored(self):
        sent=[]
        def fetch(code,now):
            if code==STATION_B: raise sync.UnusableSeries('no_data')
            return {'station':code,'collectedAt':TIME,'readings':[[TIME,1440],[TIME-300000,1430]]}
        def post(url,token,body=None):
            sent.append((url,body['station']))
            return {'ok':True,'station':body['station'],'readings':2,'observedAt':'2026-11-15T14:00:00Z'}
        with patch.object(sync,'load_vigicrues_station',side_effect=fetch),patch.object(sync,'signed_json',side_effect=post):
            stored=sync.handle_station(STATION_A,'jwt')
            missing=sync.handle_station(STATION_B,'jwt')
        self.assertEqual(stored['state'],'stored')
        self.assertEqual(missing['state'],'unavailable')
        self.assertEqual(sent,[(sync.SYNC_URL,STATION_A),(sync.UNAVAILABLE_URL,STATION_B)])

    def test_rejects_invalid_or_excessive_station_list(self):
        for bad in ([STATION_A,STATION_A],['INVALID'],[STATION_A]*201):
            with patch.object(sync,'signed_json',return_value={'ok':True,'stations':bad}):
                with self.assertRaises(RuntimeError):
                    sync.active_station_codes('jwt')

if __name__=='__main__':
    unittest.main()
