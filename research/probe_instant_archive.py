#!/usr/bin/env python3
"""Audit public historical minute-level hydrometry archive access (no writes, no alerts).

Discovery only: never download multi-GB archives without verifying an
accessible direct resource, server support for streaming, and its licence.
"""
import json
import urllib.request
import urllib.parse

API="https://www.data.gouv.fr/api/1/datasets/donnees-aux-stations-hydrometriques/"
STATION="Y531201001"

def main():
    req=urllib.request.Request(API,headers={"User-Agent":"RiviereAlerteResearch/0.2","Accept":"application/json"})
    with urllib.request.urlopen(req,timeout=50) as r: source=json.load(r)
    print("DATASET",source.get("title"),"updated",source.get("last_modified"))
    for i,item in enumerate(source.get("resources",[])):
        title=item.get("title") or ""
        url=item.get("url") or ""
        print("RESOURCE",json.dumps({"index":i,"title":title,"url":url,
              "format":item.get("format"),"filesize":item.get("filesize"),
              "type":item.get("type")},ensure_ascii=False))
    print("EXPECTED_STATION",STATION,
          "expected_archive_letter",STATION[0],
          "source_format","semicolon delimited CSV files, one year per folder")
    archives=[item for item in source.get("resources",[])
              if "Stations V-Z" in (item.get("title") or "")]
    for archive in archives:
        base=archive.get("url","")
        for url in (base,base.rstrip("/")+"/download"):
            try:
                req=urllib.request.Request(url,method="HEAD",
                     headers={"User-Agent":"RiviereAlerteResearch/0.2"})
                with urllib.request.urlopen(req,timeout=20) as response:
                    print("ARCHIVE_HEAD",json.dumps({"url":url,
                        "status":response.status,"final":response.url,
                        "content_type":response.headers.get("Content-Type"),
                        "content_length":response.headers.get("Content-Length"),
                        "accept_ranges":response.headers.get("Accept-Ranges")}))
            except Exception as exc:
                print("ARCHIVE_HEAD_ERROR",json.dumps({"url":url,
                   "type":type(exc).__name__,"message":str(exc)[:300]}))
if __name__=="__main__":main()
