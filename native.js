/* Jembatan Android (APK): membuat navigator.bluetooth memakai Bluetooth asli Android
   dan menjaga layar tetap menyala. Di browser biasa file ini tidak melakukan apa-apa. */
(function(){
  var C=window.Capacitor;
  if(!C||!C.isNativePlatform||!C.isNativePlatform())return;
  var P={};
  ['KeepAwake','PushNotifications','BluetoothLe'].forEach(function(n){
    try{P[n]=(C.Plugins&&C.Plugins[n])||(C.registerPlugin&&C.registerPlugin(n))||null}catch(e){P[n]=null}
  });
  try{if(P.KeepAwake&&P.KeepAwake.keepAwake)P.KeepAwake.keepAwake()}catch(e){}
  /* notifikasi native (FCM) — aktif bila APK dibuat dengan google-services.json (window.POS_FCM) */
  if(P.PushNotifications&&window.POS_FCM){
    var PN=P.PushNotifications,cur='',hooked=false;
    window.nativePush={
      async sync(api,want){
        try{
          if(!want){await this.off(api);return}
          var pr=await PN.requestPermissions();if(pr.receive!=='granted')return;
          if(!hooked){hooked=true;
            PN.addListener('registration',function(t){cur=t.value;try{localStorage.setItem('pos_fcm',cur)}catch(e){};
              api('/api/push/fcm',{method:'POST',body:JSON.stringify({token:cur})}).catch(function(){})})}
          await PN.register();
          if(cur)api('/api/push/fcm',{method:'POST',body:JSON.stringify({token:cur})}).catch(function(){});
        }catch(e){}
      },
      async off(api){
        var t=cur;try{t=t||localStorage.getItem('pos_fcm')||''}catch(e){}
        if(t)try{await api('/api/push/fcm',{method:'DELETE',body:JSON.stringify({token:t})})}catch(e){}
      }
    };
  }
  var BLE=P.BluetoothLe;
  if(!BLE){navigator.bluetooth={requestDevice:async function(){throw new Error('Plugin Bluetooth tidak ada di APK ini. Buat ulang APK dengan package.json terbaru.')},getDevices:async function(){return[]}};return}
  var ready=null,devs={};
  function init(){return ready||(ready=BLE.initialize({androidNeverForLocation:true}))}
  function hex(u){var s='';u=u instanceof Uint8Array?u:new Uint8Array(u.buffer||u);for(var i=0;i<u.length;i++)s+=(u[i]<16?'0':'')+u[i].toString(16);return s}
  function make(id,name){
    if(devs[id])return devs[id];
    var d={id:id,name:name||'',_ls:[],_con:false,_h:null};
    d.addEventListener=function(t,f){if(t==='gattserverdisconnected')d._ls.push(f)};
    d.removeEventListener=function(){};
    d.gatt={
      get connected(){return d._con},
      connect:async function(){
        await init();
        if(!d._h){d._h=await BLE.addListener('disconnected|'+id,function(){d._con=false;d._ls.forEach(function(f){try{f()}catch(e){}})})}
        await BLE.connect({deviceId:id,timeout:10000});
        d._con=true;
        return{getPrimaryServices:async function(){
          var r=await BLE.getServices({deviceId:id});
          return (r.services||[]).map(function(sv){return{
            uuid:sv.uuid,
            getCharacteristics:async function(){return (sv.characteristics||[]).map(function(ch){
              var pr=ch.properties||{};
              return{uuid:ch.uuid,properties:{write:!!pr.write,writeWithoutResponse:!!pr.writeWithoutResponse},
                writeValue:function(v){return BLE.write({deviceId:id,service:sv.uuid,characteristic:ch.uuid,value:hex(v)})},
                writeValueWithoutResponse:function(v){return BLE.writeWithoutResponse({deviceId:id,service:sv.uuid,characteristic:ch.uuid,value:hex(v)})}};
            })}
          }});
        }};
      },
      disconnect:function(){d._con=false;try{BLE.disconnect({deviceId:id})}catch(e){}}
    };
    return devs[id]=d;
  }
  navigator.bluetooth={
    requestDevice:async function(o){
      await init();
      var r;try{r=await BLE.requestDevice({optionalServices:(o&&o.optionalServices||[]).map(function(u){return typeof u==='number'?('0000'+u.toString(16)).slice(-4).padStart(8,'0')+'-0000-1000-8000-00805f9b34fb':u})})}catch(err){var e2=new Error(err&&err.message||'Dibatalkan');e2.name='NotFoundError';throw e2}
      var x=r.device||r;
      if(!x||!x.deviceId){var e=new Error('Tidak ada printer dipilih');e.name='NotFoundError';throw e}
      return make(x.deviceId,x.name);
    },
    getDevices:async function(){
      var id='',nm='';try{id=localStorage.getItem('pos_bleid')||'';nm=localStorage.getItem('pos_blename')||''}catch(e){}
      return id?[make(id,nm)]:[];
    }
  };
})();
