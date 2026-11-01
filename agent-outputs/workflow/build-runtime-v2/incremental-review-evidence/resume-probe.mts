import {BuildLeaderSupervisor} from '/tmp/feishu-build-v2-feature-tree/server/src/kb/build-leader-supervisor.ts';
const state:any={schemaVersion:2,orchestrationMode:'pi-amagi',generation:1,runtimeEpoch:1,spec:{buildId:'b_crashed',generation:1},binding:{buildId:'b_crashed',leaderPid:2147483647,leaderSessionId:'old',resumeCapability:{session:true,artifact:true},termination:null},actors:[{nativeTaskId:'old-task',generation:1,runtimeEpoch:1,status:'confirmed',execState:'running'}],termination:null,endedReason:null,idleRemindedAt:null};
let checks=0;const cb:any={log:()=>{},persistCheckpoint:()=>{},revokeCredentials:()=>{},rotateGeneration:()=>{},actorSnapshot:()=>({acceptedDocumentCount:0,openBlockingCount:0,activeAssignments:0}),reconcileResiduals:async()=>{checks++;return {state:'unconfirmed',children:[],note:'fixture live child',at:new Date().toISOString()};},currentRuntimeFreeze:()=>({})};
const supervisor:any=new BuildLeaderSupervisor(cb,state,{idleGraceMs:1});
await supervisor.prepareResume({spec:state.spec,signal:new AbortController().signal,resumeMode:'rebuild'});
console.log('CRASH_WITHOUT_TERMINATION_RECORD',JSON.stringify({reconcileCalls:checks,generation:state.generation,runtimeEpoch:state.runtimeEpoch,guardAllowed:true}));
// Session preserves epoch but changes generation: old actors must not block idle.
state.runtimeEpoch=1;state.generation=2;state.idleRemindedAt=new Date(0).toISOString();supervisor.lastActivityAt=0;
console.log('HISTORICAL_GENERATION_IDLE',JSON.stringify({stateGeneration:state.generation,oldActorGeneration:state.actors[0].generation,epoch:state.runtimeEpoch,outcome:supervisor.evaluateIdle()}));
