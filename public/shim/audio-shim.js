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
var relayOn=false;
var relayChunks=0;
var relaySamples=0;
/* v1.24：静音块整块跳过（见 WORKLET_SRC 注释）。这里累计网页侧跳过了多少采样，
   诊断报告用它证明「另一个上下文是不是在灌静音」。 */
var relaySkipped=0;
/* ★ v1.21：采样率不再用全局单值。
   之前 relaySrcRate 只有一个变量，取最后一次 noteRate 的值；大厅与游戏
   可能各自 48000 / 44100，用错速率重采样 → 变调 + 断续。
   现在采样率跟着 context 走，随每块数据一起送进原生。 */
function b64FromBytes(bytes){
  var bin='';
  var CH=0x8000;
  for(var j=0;j<bytes.length;j+=CH){
    bin+=String.fromCharCode.apply(null,bytes.subarray(j,j+CH));
  }
  return btoa(bin);
}
/* 送一块 Int16 PCM 给原生。rate 是该 context 的真实采样率。 */
function relaySendInt16(buf,count,rate){
  try{
    if(!relayOn||!count)return;
    var b64=b64FromBytes(new Uint8Array(buf));
    window.CARCADE_NATIVE && window.CARCADE_NATIVE.relayPush(b64,count,rate||48000);
    relayChunks++;relaySamples+=count;
  }catch(e){}
}
/* ---- 采集节点：优先 AudioWorklet，退化到 ScriptProcessor ----
   ★ 卡顿的根因：ScriptProcessor 的 onaudioprocess 跑在**主线程**。
   大厅不费 CPU 所以没事；一进游戏主线程被渲染占满，回调被延迟/跳过，
   音频立刻断续。而且旧实现把「透传输出」也交给这个回调，等于让主线程
   直接决定声音能不能出去。
   AudioWorklet 的 process() 跑在**音频线程**，不受游戏主线程影响。
   Worklet 源码用 Blob URL 加载，不需要额外资源文件（assets 里配 worklet
   路径在 WebView 下很麻烦，Blob 在 SDK 32 的 Chromium 96 上可用）。

   ★ 另一个卡顿源（v1.23 修）：process() 每 128 帧就被调用一次，旧实现**每次都
   postMessage + base64 + 过 JS 桥**，等于每秒 375 次跨语言调用，全部落在主线程上。
   车机诊断报告里「已送 12076 块 / 1545728 采样」正是 128 样本一块 ——
   主线程被这 375 次/秒的调用切成碎片，rAF 帧间隔必然抖。
   现在在音频线程里累积到 2048 帧（约 43ms）再发一次，过桥次数降到 1/16。

   ★ v1.24 的根因：**静音块必须整块跳过**。
   每个 HTML 文档（大厅、每个游戏页）都会被注入本 shim，各自造一个 AudioContext。
   大厅进游戏后音乐只是 gain 淡到 0，**图还在渲染**，worklet 照样按 48kHz 把静音
   采样发给原生 —— 游戏页自己那路也在发，两路相加等于 2 倍实时产出。
   原生队列有上限，于是长期灌满、丢块；真车报告里「队列 28 块 + 轨道缓冲 0.5s
   = 延迟 1694ms、丢 8706/20586 块」就是这么来的。
   现在缓冲全零就不发；跳过的采样数挂在下一块真实数据上带出去（不额外过桥）。 */
var WORKLET_SRC=[
"class CcRelayTap extends AudioWorkletProcessor{",
"  constructor(){super();",
"    this.cap=2048;this.buf=new Int16Array(this.cap);this.n=0;",
"    this.rate=(typeof sampleRate==='number'&&sampleRate>0)?sampleRate:48000;",
"    this.posted=0;this.nz=0;this.silent=0;",
"  }",
"  flush(){",
"    if(this.n<=0)return;",
"    if(this.nz===0){",
"      this.silent+=this.n;this.n=0;",
"      if(this.silent>=this.rate*4){this.port.postMessage({n:0,s:this.silent});this.silent=0;}",
"      return;",
"    }",
"    var ab=new ArrayBuffer(this.n*2);",
"    new Int16Array(ab).set(this.buf.subarray(0,this.n));",
"    var msg={b:ab,n:this.n,r:this.rate};",
"    if(this.silent>0){msg.s=this.silent;this.silent=0;}",
"    this.port.postMessage(msg,[ab]);",
"    this.posted++;this.n=0;this.nz=0;",
"  }",
"  process(inputs,outputs){",
"    var out=outputs[0];",
"    if(!out||!out.length)return true;",
"    var inp=inputs[0];",
"    if(!inp||!inp.length){ for(var c=0;c<out.length;c++)out[c].fill(0); return true; }",
"    for(var k=0;k<out.length;k++){ var s=inp[Math.min(k,inp.length-1)]; if(s)out[k].set(s); }",
"    var n=inp[0].length,d0=inp[0],d1=inp.length>1?inp[1]:null;",
"    for(var i=0;i<n;i++){",
"      var v=d1?(d0[i]+d1[i])*0.5:d0[i];",
"      v=v<-1?-1:(v>1?1:v);",
"      var q=v<0?v*32768:v*32767;",
"      if(q!==0)this.nz++;",
"      this.buf[this.n++]=q;",
"      if(this.n>=this.cap)this.flush();",
"    }",
"    return true;",
"  }",
"}",
"registerProcessor('cc-relay-tap',CcRelayTap);"
].join('\n');
var workletUrl=null;
function getWorkletUrl(){
  if(workletUrl)return workletUrl;
  try{
    workletUrl=URL.createObjectURL(new Blob([WORKLET_SRC],{type:'application/javascript'}));
  }catch(e){workletUrl=null;}
  return workletUrl;
}
/* 兜底采集：只在 worklet 加载失败时用。输出被 silent 增益吃掉，
   所以不会再出现「透传 + 原生」双路同时出声。 */
function makeScriptTap(ctx,rate){
  try{
    var sp=ctx.createScriptProcessor(4096,2,2);
    sp.onaudioprocess=function(ev){
      if(!relayOn)return;
      try{
        var ib=ev.inputBuffer,len=ib.length;
        var d0=ib.getChannelData(0);
        var d1=ib.numberOfChannels>1?ib.getChannelData(1):null;
        var buf=new ArrayBuffer(len*2),dv=new DataView(buf);
        var nz=0;
        for(var i=0;i<len;i++){
          var v=d1?(d0[i]+d1[i])*0.5:d0[i];
          v=v<-1?-1:(v>1?1:v);
          var q=v<0?v*32768:v*32767;
          if(q!==0)nz++;
          dv.setInt16(i*2,q,true);
        }
        /* 与 worklet 同一规则：整块静音就不占带宽、不灌原生队列 */
        if(nz===0){relaySkipped+=len;return;}
        relaySendInt16(buf,len,rate);
      }catch(e){}
    };
    return sp;
  }catch(e){return null;}
}
function tryResume(c){try{if(c&&c.state==='suspended'){var p=c.resume();if(p&&p.catch){p.catch(function(){});}}}catch(e){}}
function resumeAll(){for(var i=0;i<contexts.length;i++){tryResume(contexts[i]);}for(var m=0;m<mediaEls.length;m++){try{mediaEls[m].play();}catch(e){}}}
function track(c){if(contexts.indexOf(c)<0){contexts.push(c);}tryResume(c);}
function readMode(){try{return localStorage.getItem(MODE_KEY)==='media';}catch(e){return false;}}
/* ================= 音频出口路由（媒体通道 / PCM 中转） =================
   ★ 三条硬规则，之前的实现全违反了，是卡顿与「开关点了没用」的根源：
   1. **互斥**：一个 context 只能有一个出口。旧代码 setRelay(true) 会往一个
      已经被媒体通道覆写的 context 上再装采集节点，而它以 ctx.destination
      作为「真输出」—— 那其实是媒体流目的地。结果媒体元素与原生 AudioTrack
      同时播同一路声音，两路延迟不同 → 卡顿/拖音。
   2. **可逆**：卸载时必须 `delete ctx.destination` 把原型的访问器换回来。
      旧代码关闭媒体通道时只 pause 了 <audio>，getter 还指着一个已暂停的流
      → 声音彻底没了，再切回来也回不来。
   3. **透传不经过主线程**：tap 增益节点直接把声音送到真输出，
      采集节点挂在旁路、用 0 增益吃掉输出，只负责取数据。
      这样主线程再忙也不会把「发声」这条路堵住。
   ===================================================================== */
function uninstallRoute(ctx){
  if(!ctx)return false;
  try{
    if(ctx.__ccRelayNode){try{ctx.__ccRelayNode.disconnect();}catch(e){}try{ctx.__ccRelayNode.onaudioprocess=null;}catch(e){}}
    if(ctx.__ccWorklet){try{ctx.__ccWorklet.port.onmessage=null;ctx.__ccWorklet.disconnect();}catch(e){}}
    if(ctx.__ccRelayTap){try{ctx.__ccRelayTap.disconnect();}catch(e){}}
    if(ctx.__ccSilent){try{ctx.__ccSilent.disconnect();}catch(e){}}
    if(ctx.__ccMediaEl){
      try{ctx.__ccMediaEl.pause();}catch(e){}
      try{ctx.__ccMediaEl.srcObject=null;}catch(e){}
      try{ctx.__ccMediaEl.remove();}catch(e){}
    }
  }catch(e){}
  ctx.__ccRelayNode=null;ctx.__ccWorklet=null;ctx.__ccRelayTap=null;
  ctx.__ccSilent=null;ctx.__ccMediaEl=null;ctx.__ccMediaDest=null;ctx.__ccRoute=null;
  /* 关键：删掉自有属性，原型上的真 destination 访问器回来 */
  try{delete ctx.destination;}catch(e){}
  return true;
}
/* 媒体通道：同一个 context 里建 MediaStreamDestination，
   覆写 destination 指向它，再用 <audio>.srcObject 播放这条流 →
   网页音频走 Chromium 的媒体元素管线（车机放行的那条）。 */
function installMedia(ctx){
  uninstallRoute(ctx);
  try{
    var dest=ctx.createMediaStreamDestination();
    var el=document.createElement('audio');
    el.autoplay=true;el.setAttribute('playsinline','');el.volume=1;el.muted=false;
    el.srcObject=dest.stream;
    try{(document.body||document.documentElement).appendChild(el);}catch(e){}
    var pr=el.play();
    if(pr&&pr.catch){pr.catch(function(){});}
    Object.defineProperty(ctx,'destination',{configurable:true,get:function(){return dest;}});
    ctx.__ccMediaDest=dest;
    ctx.__ccMediaEl=el;
    ctx.__ccRoute='media';
    mediaEls.push(el);
    return true;
  }catch(e){return false;}
}
/* PCM 中转：tap（增益）接管 destination，
   tap → 真输出（透传，主线程无关）
   tap → 采集节点 → silent(0) → 真输出（只为拉动采集，不出声） */
function installRelay(ctx){
  uninstallRoute(ctx);
  try{
    var realDest=ctx.destination;          /* 已卸载 → 原型访问器 → 真输出 */
    var rate=ctx.sampleRate||48000;
    var tap=ctx.createGain();tap.gain.value=1;
    tap.connect(realDest);
    var silent=ctx.createGain();silent.gain.value=0;
    silent.connect(realDest);
    /* 先用 ScriptProcessor 兜底，worklet 就绪后替换 —— 保证开到就有声 */
    var node=makeScriptTap(ctx,rate);
    if(node){tap.connect(node);node.connect(silent);}
    var wu=getWorkletUrl();
    if(wu&&ctx.audioWorklet&&ctx.audioWorklet.addModule){
      try{
        ctx.audioWorklet.addModule(wu).then(function(){
          if(ctx.__ccRoute!=='relay')return;       /* 期间被切走了，不要装 */
          var wn=new AudioWorkletNode(ctx,'cc-relay-tap',{
            numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[2]
          });
          wn.port.onmessage=function(ev){
            var d=ev&&ev.data;if(!d)return;
            /* s = 上一段被跳过的静音采样数（worklet 攒着一起报，不额外过桥） */
            if(d.s>0)relaySkipped+=d.s;
            /* 新格式 {b:ArrayBuffer,n:采样数,r:采样率}；兼容旧格式的裸 ArrayBuffer */
            if(d.b){relaySendInt16(d.b,d.n||(d.b.byteLength>>1),d.r||rate);}
            else if(d.byteLength){relaySendInt16(d,(d.byteLength>>1),rate);}
          };
          tap.connect(wn);wn.connect(silent);
          if(ctx.__ccRelayNode){try{ctx.__ccRelayNode.disconnect();ctx.__ccRelayNode.onaudioprocess=null;}catch(e){}}
          ctx.__ccRelayNode=null;
          ctx.__ccWorklet=wn;
        },function(){});
      }catch(e){}
    }
    Object.defineProperty(ctx,'destination',{configurable:true,get:function(){return tap;}});
    ctx.__ccRelayTap=tap;
    ctx.__ccSilent=silent;
    ctx.__ccRelayNode=node;
    ctx.__ccRoute='relay';
    return true;
  }catch(e){return false;}
}
/* 按当前开关重装某个 context 的出口。任何开关切换都走这里，
   保证「先完整卸载，再装唯一一条」，不会出现残留叠加。 */
function applyRouting(ctx){
  if(!ctx)return false;
  try{
    if(relayOn)return installRelay(ctx);
    if(mediaMode)return installMedia(ctx);
    return uninstallRoute(ctx);
  }catch(e){return false;}
}
function makeContext(){
  var c=new AC();
  track(c);
  applyRouting(c);
  return c;
}
function PatchedAC(){return makeContext();}
PatchedAC.prototype=AC?AC.prototype:{};
try{window.AudioContext=PatchedAC;}catch(e){}
try{if(window.webkitAudioContext){window.webkitAudioContext=PatchedAC;}}catch(e){}
/* v1.23：媒体通道已废弃（真车实测走不通，见 setMode 注释），固定关闭。
   localStorage 里残留的旧值也一并清掉，避免老用户一进来又踩同一个坑。 */
mediaMode=false;
try{localStorage.setItem(MODE_KEY,'off');}catch(e){}
try{relayOn=localStorage.getItem(RELAY_KEY)==='on';}catch(e){relayOn=false;}
bridgeState=relayOn?'relay':(mediaMode?'media':'off');
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
    /* v1.23：媒体通道整条路已废弃。
       它把网页音频塞进 MediaStreamDestination → <audio>.srcObject，指望走
       Chromium 的「媒体元素管线」；但这条路最终**仍然由 WebView 进程输出**，
       车机丢的正是这条流（诊断报告里 contentType=TYPE_0 的那条）。
       真车实测：开与不开都没有声音 —— 不是开关 bug，是这条路在这台车上走不通。
       所以固定关闭，只保留真车验证有效的 PCM 中转，避免用户反复试错。 */
    mediaMode=false;
    try{localStorage.setItem(MODE_KEY,'off');}catch(e){}
    if(window.__carcadeAudioUnsupported!==true){window.__carcadeAudioUnsupported=true;}
    bridgeState=relayOn?'relay':'off';
    return false;
  },
  /* ---- PCM 中转（车机无声的正解）---- */
  relayOn:function(){return relayOn;},
  setRelay:function(on){
    on=!!on;
    /* 互斥：开 PCM 中转就关掉媒体通道 */
    if(on&&mediaMode){
      mediaMode=false;
      try{localStorage.setItem(MODE_KEY,'off');}catch(e){}
    }
    relayOn=on;
    try{localStorage.setItem(RELAY_KEY,relayOn?'on':'off');}catch(e){}
    try{window.CARCADE_NATIVE&&window.CARCADE_NATIVE.relayEnable(relayOn);}catch(e){}
    for(var i=0;i<contexts.length;i++){try{applyRouting(contexts[i]);}catch(e){}}
    bridgeState=relayOn?'relay':(mediaMode?'media':'off');
    return relayOn;
  },
  relayInfo:function(){
    var st='';
    try{var n=window.CARCADE_NATIVE;if(n&&n.relayState)st=n.relayState();}catch(e){}
    return {on:relayOn,chunks:relayChunks,samples:relaySamples,skipped:relaySkipped,native:st};
  },
  /* 每个 context 当前装的是哪条出口 —— 诊断报告据此判断有没有双路叠加 */
  routes:function(){
    var r=[];
    for(var i=0;i<contexts.length;i++){
      var c=contexts[i];
      r.push({i:i,state:c.state,rate:c.sampleRate,route:c.__ccRoute||'default',
              worklet:!!c.__ccWorklet,script:!!c.__ccRelayNode,media:!!c.__ccMediaEl});
    }
    return r;
  },
  testElement:testElement,
  testWebAudio:testWebAudio,
  lastTest:function(){return lastTest;},
  info:function(){
    return {
      mode:mediaMode?'media':'off',
      relay:relayOn,
      bridgeState:bridgeState,
      contexts:contexts.length,
      states:this.states(),
      routes:this.routes(),
      chunks:relayChunks,
      samples:relaySamples,
      skipped:relaySkipped,
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
