// vk-bridge глобально
const bridge = window.vkBridge;
bridge.send('VKWebAppInit').catch(()=>{});

// Хаптик включен по умолчанию
const canImpact = bridge?.supports?.('VKWebAppTapticImpactOccurred');
const canNotify = bridge?.supports?.('VKWebAppTapticNotificationOccurred');
function hapticImpact(style='light'){ if (canImpact) bridge.send('VKWebAppTapticImpactOccurred',{style}).catch(()=>{}); else if(navigator.vibrate) navigator.vibrate(10); }
function hapticSuccess(){ if (canNotify) bridge.send('VKWebAppTapticNotificationOccurred',{type:'success'}).catch(()=>{}); else if(navigator.vibrate) navigator.vibrate(30); }
function hapticError(){ if (canNotify) bridge.send('VKWebAppTapticNotificationOccurred',{type:'error'}).catch(()=>{}); else if(navigator.vibrate) navigator.vibrate([20,40,20]); }

// Canvas-игра
const canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
let W,H,dpr;
function resize(){ dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1)); W=canvas.clientWidth;H=canvas.clientHeight; canvas.width=W*dpr; canvas.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);} 
window.addEventListener('resize',resize);resize();

const gravity=0.03, windMax=0.05, spawnRate=0.018; 
const snow=[], hearts=[];

function rand(a,b){return a+Math.random()*(b-a);} 
function drawSnowflake(x,y,s){
  ctx.save();ctx.translate(x,y);ctx.strokeStyle = 'rgba(255,255,255,0.9)';ctx.lineWidth = 1.2;
  for(let i=0;i<6;i++){ctx.rotate(Math.PI/3);ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-s);
    ctx.moveTo(0,-s*0.6);ctx.lineTo(s*0.2,-s*0.8);ctx.moveTo(0,-s*0.3);ctx.lineTo(s*0.2,-s*0.5);ctx.stroke();}
  ctx.restore();
}
function drawHeart(x,y,s){
  ctx.save();ctx.translate(x,y);ctx.beginPath();const k=s/16;
  ctx.moveTo(0,4*k);ctx.bezierCurveTo(0,-2*k,-8*k,-2*k,-8*k,4*k);
  ctx.bezierCurveTo(-8*k,10*k,0,14*k,0,16*k);
  ctx.bezierCurveTo(0,14*k,8*k,10*k,8*k,4*k);
  ctx.bezierCurveTo(8*k,-2*k,0,-2*k,0,4*k);
  ctx.fillStyle='rgba(255,85,130,0.95)';ctx.fill();ctx.restore();
}
function spawnSnow(){ if(Math.random()<spawnRate) snow.push({x:rand(0,W),y:-10,vx:rand(-windMax,windMax),vy:rand(0.2,0.6),size:rand(4,9)}); }
function update(dt){
  for(let i=snow.length-1;i>=0;i--){
    const s=snow[i];
    s.vy=(s.vy||0)+gravity*dt; s.vx=(s.vx||0)+rand(-0.02,0.02)*dt;
    s.x+=s.vx*dt*60; s.y+=s.vy*dt*60;
    if(s.y>=H-20){ hearts.push({x:s.x,y:H-24,vy:rand(-1.4,-0.8),size:s.size*2.2,life:0}); snow.splice(i,1); hapticImpact('light'); }
    else if(s.x<-20||s.x>W+20||s.y>H+40){ snow.splice(i,1); }
  }
  for(let i=hearts.length-1;i>=0;i--){ const h=hearts[i]; h.y+=h.vy*dt*60; h.vy+=0.02*dt; h.life+=dt; if(h.life>2.5) hearts.splice(i,1); }
}
function render(){ ctx.clearRect(0,0,W,H); ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.fillRect(0,H-18,W,18);
  for(const s of snow) drawSnowflake(s.x,s.y,s.size); for(const h of hearts) drawHeart(h.x,h.y,h.size); }
let last=performance.now(); function loop(t){ const dt=Math.min(0.033,(t-last)/1000); last=t; spawnSnow(); update(dt); render(); requestAnimationFrame(loop);} requestAnimationFrame(loop);

// Тап/клик — превратить ближайшую снежинку + хаптик
canvas.addEventListener('pointerdown',ev=>{ 
  const r=canvas.getBoundingClientRect(),x=ev.clientX-r.left,y=ev.clientY-r.top; 
  let idx=-1,best=1e9;
  for(let i=0;i<snow.length;i++){ const s=snow[i],d2=(s.x-x)**2+(s.y-y)**2; if(d2<best){best=d2; idx=i;} }
  if(idx>=0){ const s=snow[idx]; hearts.push({x:s.x,y:s.y,vy:-1.2,size:s.size*2.1,life:0}); snow.splice(idx,1); hapticImpact('light'); }
});

// ===== Монетизация: 1 голос за "Превратить все" + серверная проверка =====
const PRODUCT_ID = 'convert_all_1'; // создайте такой товар в Платежах VK

function convertAllSnowflakes(){
  for (let i = snow.length - 1; i >= 0; i--) {
    const s = snow[i];
    hearts.push({ x: s.x, y: Math.min(s.y, H-24), vy: -1.2, size: s.size*2.1, life: 0 });
  }
  snow.length = 0;
  hapticSuccess();
}

async function verifyOrderOnServer(appOrderId){
  const url='/api/orders/verify';
  const params=new URLSearchParams(window.location.search);
  const body={app_order_id:String(appOrderId), item_id:PRODUCT_ID, vk_params:Object.fromEntries(params.entries())};
  const res=await fetch(url,{method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const data=await res.json();
  return data.ok===true;
}

document.getElementById('payAllBtn').addEventListener('click', async () => {
  try {
    console.log('🧾 Отправка VKWebAppShowOrderBox...');
    const result = await bridge.send('VKWebAppShowOrderBox', {
      type: 'item',
      item: PRODUCT_ID,
    });
    console.log('✅ Успех VKWebAppShowOrderBox:', result);
  } catch (err) {
    console.error('❌ Ошибка VKWebAppShowOrderBox:', err);
    hapticError();
  }
});


bridge.subscribe(async ({ detail }) => {
  const { type, data } = detail || {};

/*   if (type === 'VKWebAppOrderSuccess') {
    console.log('💰 Успешная покупка:', data);
    try { const ok = await verifyOrderOnServer(data.app_order_id); if (ok) convertAllSnowflakes(); else hapticError(); }
    catch { hapticError(); }
  } else if (type === 'VKWebAppOrderFail') {
    console.error('⚠️ Ошибка оплаты:', data);
  } else if (type === 'VKWebAppOrderCancel') {
    console.warn('🚫 Покупка отменена пользователем:', data);
  } */

  bridge.subscribe(async ({ detail }) => {
  const { type, data } = detail || {};
  if (type === 'VKWebAppShowOrderBoxResult') {
    try {
      const ok = await verifyOrderOnServer(data.order_id); // <-- правильное поле
      if (ok) convertAllSnowflakes();
      else hapticError();
    } catch { hapticError(); }
  } else if (type === 'VKWebAppShowOrderBoxFailed') {
    console.error('⚠️ Ошибка оплаты:', data);
  }
});
  
});
