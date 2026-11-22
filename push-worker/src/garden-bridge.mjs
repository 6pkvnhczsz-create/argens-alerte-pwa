// Isolated best-effort bridge. The flood-warning cron must never depend on
// Smart Garden's credentials, availability, API latency or notification result.
// RPC through a named Service Binding exposes no public scheduling endpoint.
export async function runGardenBridge(env){
  try {
    const garden=env?.SMART_GARDEN_MONITOR;
    if(!garden || typeof garden.run!=="function")
      throw Error("SMART_GARDEN_MONITOR Service Binding not available");
    const result=await garden.run();
    if(!result?.ok)throw Error("Smart Garden reported unsuccessful scheduled check");
    return {ok:true,checkedAt:result.checkedAt||null};
  }catch(error){
    const reason=String(error?.message||error).slice(0,180);
    console.error("Smart Garden scheduled monitor failed (flood alerts unaffected)",reason);
    return {ok:false,error:reason};
  }
}
