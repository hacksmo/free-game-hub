(function(){
if(window.__carcadeAudioShim)return;
window.__carcadeAudioShim=true;
var AC=window.AudioContext||window.webkitAudioContext;
var MODE_KEY='carcade:audioMode';
var RELAY_KEY='carcade:audioRelay';
var contexts=[];
var mediaMode=false;
var bridgeState='off';
var mediaDest=null;
var mediaEl=null;
var mediaEls=[];
var lastTest={element:null,webaudio:null};
/* ---- 网页音频 PCM 中转（车机无声的正解）----
   做法：在 WebAudio 图的**末端**插一个 ScriptProcessorNode，
   把渲染出来的采样取出来（postMessage 到主线程）→ 交给原生 AudioTrack 播放。
   这样网页的声音不再依赖 Chromium 自己的输出路由（那条在车机上被丢弃），
   而是走「原生 legacy AudioTrack」——真车已验证 1–20 通道全部可闻。

   注意：ScriptProcessor 是 deprecated API，但它在 Android WebView 上
   唯一能用（AudioWorklet 需要单独的 worklet 文件 URL，在 assets 里加载路径麻烦）。

   ★ 采样率：AudioContext 默认 48000（真车实测），原生播放端是 24000。
     速率不一致会变调 + 断续 —— 所以把 ctx.sampleRate 一起传过去，由原生做重采样。 */
var PCM_RATE=24000;
var relayOn=false;
var relayState='off';
var relayChunks=0;
var relaySamples=0;
/* AudioContext 的实际采样率：首个 context 建立后才有值 */
var relaySrcRate=48000;
function relaySend(samples){
  try{
    var n=samples.length;
    if(!n)return;
    var buf=new ArrayBuffer(n*2);
    var view=new DataView(buf);
    for(var i=0;i<n;i++){
      var v=Math.max(-1,Math.min(1,samples[i]));
      view.setInt16(i*2,v<0?v*32768:v*32767,true);
    }
    var bytes=new Uint8Array(buf);
    var bin='';
    var CH=0x8000;
    for(var j=0;j<bytes.length;j+=CH){
      bin+=String.fromCharCode.apply(null,bytes.subarray(j,j+CH));
    }
    window.CARCADE_NATIVE && window.CARCADE_NATIVE.relayPush(btoa(bin), n, relaySrcRate);
    relayChunks++;relaySamples+=n;
  }catch(e){}
}
function makeRelayNode(ctx){
  try{
    /* 2 进 2 出：与游戏常见的立体声图匹配，避免声道数不匹配导致静音。
       采集节点必须能连到真正的 destination，否则渲染图不会被拉动，
       onaudioprocess 根本不会触发。 */
    var node=ctx.createScriptProcessor(4096,2,2);
    node.onaudioprocess=function(ev){
      try{
        var ib=ev.inputBuffer,ob=ev.outputBuffer;
        var len=ib.length;
        /* 原样透传：若车机本身能出声，这条路径仍然正常，不会重复也不会丢 */
        for(var ch=0;ch<ob.numberOfChannels;ch++){
          var src=ib.getChannelData(Math.min(ch,ib.numberOfChannels-1));
          ob.getChannelData(ch).set(src);
        }
        if(!relayOn)return;
        /* 混成单声道送回原生 */
        var d0=ib.getChannelData(0);
        var d1=ib.numberOfChannels>1?ib.getChannelData(1):null;
        var out=new Float32Array(len);
        for(var i=0;i<len;i++){out[i]=d1?(d0[i]+d1[i])*0.5:d0[i];}
        relaySend(out);
      }catch(e){}
    };
    return node;
  }catch(e){return null;}
}
function tryResume(c){try{if(c&&c.state==='suspended'){var p=c.resume();if(p&&p.catch){p.catch(function(){});}}}catch(e){}}
function resumeAll(){for(var i=0;i<contexts.length;i++){tryResume(contexts[i]);}for(var m=0;m<mediaEls.length;m++){try{mediaEls[m].play();}catch(e){}}}
function track(c){if(contexts.indexOf(c)<0){contexts.push(c);}tryResume(c);}
/* 记录 AudioContext 的实际采样率（真车实测 48000），原生端据此重采样 */
function noteRate(c){try{if(c&&c.sampleRate){relaySrcRate=c.sampleRate;}}catch(e){}}
function readMode(){try{return localStorage.getItem(MODE_KEY)==='media';}catch(e){return false;}}
function isSinkSupported(){try{return typeof AC==='function' && 'sinkId' in (new AC().constructor.prototype===undefined?{}:{});}catch(e){}}
function createMediaDest(ctx){try{return ctx.createMediaStreamDestination();}catch(e){return null;}}
/* 把某个 context 的输出改道到「媒体通道」：
   在**同一个 context** 里建 MediaStreamAudioDestinationNode，
   覆写 ctx.destination 指向它，再用 <audio>.srcObject 播放这条流。

   这样网页音频走的是 Chromium 的**媒体元素管线**（与 <video>/<audio> 同一条路），
   而真车实测：浏览器播视频有声音、WebAudio 没声音 —— 媒体管线正是车机放行的那条。

   ★ 之前的实现错在：MediaStreamDestination 建在一个**独立的探测 context** 里，
     游戏自己的 context 根本没接进去，等于没开过。 */
function attachMedia(ctx){
  if(!ctx||ctx.__carcadeMedia)return false;
  try{
    var dest=createMediaDest(ctx);
    if(!dest)return false;
    var el=document.createElement('audio');
    el.autoplay=true;el.setAttribute('playsinline','');el.volume=1;el.muted=false;
    el.srcObject=dest.stream;
    try{document.body&&document.body.appendChild(el);}catch(e){}
    var pr=el.play();
    if(pr&&pr.catch){pr.catch(function(){});}
    try{
      Object.defineProperty(ctx,'destination',{
        configurable:true,
        get:function(){return dest;}
      });
      ctx.__carcadeMedia=dest;
      ctx.__carcadeMediaEl=el;
      mediaEls.push(el);
      return true;
    }catch(e){return false;}
  }catch(e){return false;}
}
/* 给一个 context 装上 PCM 采集节点，并把 context.destination 指向它。
   这样游戏里 connect(ctx.destination) 的声音会先进采集节点被我们截获。 */
function attachRelay(ctx){
  if(!ctx||ctx.__carcadeRelay)return false;
  var rn=makeRelayNode(ctx);
  if(!rn)return false;
  var realDest=ctx.destination;
  rn.connect(realDest);
  try{
    Object.defineProperty(ctx,'destination',{
      configurable:true,
      get:function(){return rn;}
    });
    ctx.__carcadeRelay=rn;
    /* 记下这个 context 的实际采样率（AudioContext 默认 48000）。
       必须在装采集节点时记 —— 采集节点拿到的就是该速率的采样，
       原生播放端是 24000，不传过去就会变调 + 断续。 */
    noteRate(ctx);
    return true;
  }catch(e){return false;}
}
function makeContext(){
  var c=new AC();track(c);noteRate(c);
  /* 媒体通道与 PCM 中转都是「改写 destination」，互斥：
     同时开会让后一个覆盖前一个，行为不可预期。 */
  if(mediaMode){
    if(!attachMedia(c))bridgeState='failed: media attach';
  }else if(relayOn){
    try{attachRelay(c);}catch(e){}
  }
  return c;
}
function PatchedAC(){return makeContext();}
PatchedAC.prototype=AC?AC.prototype:{};
try{window.AudioContext=PatchedAC;}catch(e){}
try{if(window.webkitAudioContext){window.webkitAudioContext=PatchedAC;}}catch(e){}
mediaMode=readMode();
try{relayOn=localStorage.getItem(RELAY_KEY)==='on';}catch(e){relayOn=false;}
if(relayOn){try{window.CARCADE_NATIVE&&window.CARCADE_NATIVE.relayEnable(true);}catch(e){}}
var evs=['pointerdown','touchstart','mousedown','keydown','click'];
for(var i=0;i<evs.length;i++){try{window.addEventListener(evs[i],resumeAll,true);document.addEventListener(evs[i],resumeAll,true);}catch(e){}}
try{document.addEventListener('visibilitychange',function(){if(!document.hidden){resumeAll();}});}catch(e){}
resumeAll();
var n=0;var iv=setInterval(function(){resumeAll();if(++n>=12){clearInterval(iv);}},500);
function beepWav(){
  /* 之前这里塞的是一个 **data chunk 长度 0 的空 WAV**（44 字节，只有头没有采样），
     导致 A 组「<audio> 测试音」从来没真正发出过声音 ——
     报告里 duration=0、advanced:false 是必然的，那次 A/B 判定是无效实验。
     现在改成用 WebAudio 现场合成一段 0.5s / 1kHz 的真实 WAV（有采样数据）。 */
  try{
    var rate=8000,n=Math.floor(rate*0.5);
    var buf=new ArrayBuffer(44+n*2),dv=new DataView(buf);
    function wr(off,s){for(var i=0;i<s.length;i++)dv.setUint8(off+i,s.charCodeAt(i));}
    wr(0,'RIFF');dv.setUint32(4,36+n*2,true);wr(8,'WAVE');wr(12,'fmt ');
    dv.setUint32(16,16,true);dv.setUint16(20,1,true);dv.setUint16(22,1,true);
    dv.setUint32(24,rate,true);dv.setUint32(28,rate*2,true);dv.setUint16(32,2,true);
    dv.setUint16(34,16,true);wr(36,'data');dv.setUint32(40,n*2,true);
    for(var i=0;i<n;i++){
      var v=Math.sin(2*Math.PI*1000*i/rate)*0.4*32767;
      dv.setInt16(44+i*2,v|0,true);
    }
    var bytes=new Uint8Array(buf),bin='',CH=0x8000;
    for(var j=0;j<bytes.length;j+=CH){bin+=String.fromCharCode.apply(null,bytes.subarray(j,j+CH));}
    return 'data:audio/wav;base64,'+btoa(bin);
  }catch(e){return '';}
}
function testElement(){
  return new Promise(function(resolve){
    var out={ok:false,error:null,started:false,advanced:false};
    try{
      var el=document.createElement('audio');
      el.src=beepWav();el.autoplay=true;el.volume=1;
      el.addEventListener('playing',function(){out.started=true;});
      el.addEventListener('error',function(){out.error='media error';});
      var pr=el.play();
      if(pr&&pr.catch){pr.catch(function(e){out.error=e&&e.message?e.message:String(e);});}
      setTimeout(function(){
        try{out.advanced=el.currentTime>0;out.duration=el.duration;}catch(e){}
        out.ok=out.started||out.advanced;
        lastTest.element=out;resolve(out);
      },700);
    }catch(e){out.error=String(e);lastTest.element=out;resolve(out);}
  });
}
function testWebAudio(){
  return new Promise(function(resolve){
    var out={ok:false,error:null,state:null,started:false};
    try{
      var ctx=new AC();
      track(ctx);
      out.state=ctx.state;
      var t0=ctx.currentTime;
      var osc=ctx.createOscillator(),g=ctx.createGain();
      osc.type='triangle';osc.frequency.setValueAtTime(660,t0);
      g.gain.setValueAtTime(0.0001,t0);
      g.gain.linearRampToValueAtTime(0.3,t0+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+0.4);
      osc.connect(g);g.connect(ctx.destination);
      osc.start(t0);osc.stop(t0+0.45);
      if(ctx.state==='suspended'&&ctx.resume){ctx.resume();}
      setTimeout(function(){
        out.state=ctx.state;
        out.started=ctx.state==='running';
        out.ok=out.started;
        lastTest.webaudio=out;resolve(out);
      },600);
    }catch(e){out.error=String(e);lastTest.webaudio=out;resolve(out);}
  });
}
window.__carcadeAudio={
  contexts:contexts,
  resumeAll:resumeAll,
  states:function(){var s=[];for(var i=0;i<contexts.length;i++){s.push(contexts[i].state);}return s;},
  mode:function(){return mediaMode?'media':'off';},
  bridgeState:function(){return bridgeState;},
  setMode:function(on){
    try{localStorage.setItem(MODE_KEY,on?'media':'off');}catch(e){}
    mediaMode=!!on;
    /* 对**已有**的 context 也立即改道，否则用户开了开关但当前页面没声音，
       会以为开关没用（需要重启才生效的体验很差）。 */
    for(var i=0;i<contexts.length;i++){
      try{
        if(mediaMode){attachMedia(contexts[i]);}
        else if(contexts[i].__carcadeMedia){
          /* 关掉媒体通道：恢复真正的 destination */
          var c=contexts[i];
          try{
            var real=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(c),'destination');
            delete c.__carcadeMedia;
            if(c.__carcadeMediaEl){try{c.__carcadeMediaEl.pause();}catch(e){}}
          }catch(e){}
        }
      }catch(e){}
    }
    bridgeState=mediaMode?'media':'off';
    return mediaMode;
  },
  /* ---- PCM 中转（车机无声的正解）---- */
  relayOn:function(){return relayOn;},
  setRelay:function(on){
    relayOn=!!on;
    try{localStorage.setItem(RELAY_KEY,relayOn?'on':'off');}catch(e){}
    if(relayOn){
      /* 通知原生开启 AudioTrack 播放端 */
      try{window.CARCADE_NATIVE&&window.CARCADE_NATIVE.relayEnable(true);}catch(e){}
      /* 已有 context 也要装采集节点 */
      for(var i=0;i<contexts.length;i++){try{attachRelay(contexts[i]);}catch(e){}}
    }else{
      try{window.CARCADE_NATIVE&&window.CARCADE_NATIVE.relayEnable(false);}catch(e){}
    }
    return relayOn;
  },
  relayInfo:function(){
    var st='off';
    try{var n=window.CARCADE_NATIVE;if(n&&n.relayState)st=n.relayState();}catch(e){}
    return {on:relayOn,chunks:relayChunks,samples:relaySamples,native:st};
  },
  testElement:testElement,
  testWebAudio:testWebAudio,
  lastTest:function(){return lastTest;},
  info:function(){
    return {
      mode:mediaMode?'media':'off',
      bridgeState:bridgeState,
      contexts:contexts.length,
      states:this.states(),
      element:lastTest.element,
      webaudio:lastTest.webaudio
    };
  }
};
/* ---- 埋点上报：window.__carcadeTrack(event, payload) ----
   event: session_open / game_start / game_end
   payload: {gameId, durationMs}
   · 服务端地址取 window.__carcadeApiBase（由 src/data/remote.ts 的唯一常量下发），缺省回落到默认域名
   · 3 秒超时、失败静默、绝不阻塞游戏；待发队列上限 50 条（超出丢弃最旧）
   · 页面隐藏时暂停发送，恢复可见后继续
   · 注意：函数名统一带 cc 前缀，避免与上方音频相关的 track(c) 等同名声明冲突 */
var ccTrackKey='carcade:deviceId';
var ccQueue=[];
var ccMax=50;
var ccSent=0;
var ccFailed=0;
var ccHidden=false;
var ccBusy=false;
var ccBaseDefault='https://games.hackmo.net';
function ccBase(){try{var b=window.__carcadeApiBase;if(typeof b==='string'&&b.length>0){return b.replace(/\/+$/,'');}return ccBaseDefault;}catch(e){return ccBaseDefault;}}
function ccDeviceId(){
  try{
    var v=localStorage.getItem(ccTrackKey);
    if(v)return v;
    var u='';
    try{
      if(window.crypto&&typeof window.crypto.randomUUID==='function'){u=window.crypto.randomUUID();}
      else{u='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;var n=(c==='x')?r:((r&0x3)|0x8);return n.toString(16);});}
    }catch(e){u='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';}
    localStorage.setItem(ccTrackKey,u);
    return u;
  }catch(e){return 'unknown';}
}
function ccVersion(){try{var v=window.__carcadeVersion;if(typeof v==='string'&&v.length>0)return v;}catch(e){}return null;}
function ccDone(){ccBusy=false;try{ccFlush();}catch(e){}}
function ccFlush(){
  if(ccBusy||ccHidden||ccQueue.length===0)return;
  ccBusy=true;
  var body=ccQueue.shift();
  var ctrl=null;var timer=null;
  var done=function(){if(timer){clearTimeout(timer);timer=null;}ccDone();};
  try{
    if(typeof AbortController==='function'){
      ctrl=new AbortController();
      timer=setTimeout(function(){try{ctrl.abort();}catch(e){}},3000);
    }
    var opt={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
    if(ctrl)opt.signal=ctrl.signal;
    fetch(ccBase()+'/api/event',opt).then(function(){ccSent++;done();},function(){ccFailed++;done();});
  }catch(e){ccFailed++;done();}
}
function ccTrack(event,payload){
  try{
    if(!event)return;
    if(window.__carcadeOffline===true)return;
    var body={event:String(event),ts:Date.now(),deviceId:ccDeviceId()};
    var ver=ccVersion();
    if(ver)body.clientVersion=ver;
    if(payload&&typeof payload==='object'){
      if(payload.gameId)body.gameId=String(payload.gameId);
      if(typeof payload.durationMs==='number'&&isFinite(payload.durationMs))body.durationMs=Math.round(payload.durationMs);
    }
    ccQueue.push(body);
    while(ccQueue.length>ccMax)ccQueue.shift();
    ccFlush();
  }catch(e){}
}
try{ccHidden=!!document.hidden;}catch(e){}
try{
  document.addEventListener('visibilitychange',function(){
    try{ccHidden=!!document.hidden;}catch(e){}
    if(!ccHidden){try{ccFlush();}catch(e){}}
  });
}catch(e){}
window.__carcadeTrack=ccTrack;
window.__carcadeTrackInfo=function(){return {queued:ccQueue.length,sent:ccSent,failed:ccFailed,base:ccBase(),hidden:ccHidden};};
})();
