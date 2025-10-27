// vk-bridge глобально
const bridge = window.vkBridge;

// Инициализация
bridge.send('VKWebAppInit').catch(()=>{});

// Флаги поддерживаемых методов и вибро-фолбэк
const supportsImpact = bridge?.supports?.('VKWebAppTapticImpactOccurred');
const supportsNotify = bridge?.supports?.('VKWebAppTapticNotificationOccurred');

function hapticImpact(style='light'){
  if (supportsImpact) return bridge.send('VKWebAppTapticImpactOccurred', { style }).catch(()=>{});
  if (navigator.vibrate) navigator.vibrate(10);
}
function hapticSuccess(){
  if (supportsNotify) return bridge.send('VKWebAppTapticNotificationOccurred', { type: 'success' }).catch(()=>{});
  if (navigator.vibrate) navigator.vibrate(30);
}

// Пользователь (необязательно)
(async () => {
  try {
    const user = await bridge.send('VKWebAppGetUserInfo');
    document.getElementById('user').textContent = `Привет, ${user.first_name} ${user.last_name}!`;
  } catch {}
})();

// Вибрация (кнопка)
document.getElementById('vibrateBtn').addEventListener('click', () => { hapticSuccess(); });

// Canvas-игра
const canvas = document.getElementById('game'), ctx = canvas.getContext('2d');
let W,H,dpr;
function resize(){ dpr=Math.max(1,Math.min(2,window.devicePixelRatio||1)); W=canvas.clientWidth;H=canvas.clientHeight; canvas.width=W*dpr; canvas.height=H*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);} 
window.addEventListener('resize',resize);resize();

const gravity=0.03, windMax=0.05, spawnRate=0.018; 
const snow=[], hearts=[];

function rand(a,b){return a+Math.random()*(b-a);} 
function drawSnowflake(x,y,s){
  ctx.save();ctx.translate(x,y);ctx.strokeStyle='rgba(255,255,255,0.9)';ctx.lineWidth=1.2;
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
canvas.addEventListener('pointerdown',ev=>{ const r=canvas.getBoundingClientRect(),x=ev.clientX-r.left,y=ev.clientY-r.top; let idx=-1,best=1e9;
  for(let i=0;i<snow.length;i++){ const s=snow[i],d2=(s.x-x)**2+(s.y-y)**2; if(d2<best){best=d2; idx=i;} }
  if(idx>=0){ const s=snow[idx]; hearts.push({x:s.x,y:s.y,vy:-1.2,size:s.size*2.1,life:0}); snow.splice(idx,1); hapticImpact('light'); }
});

// ===== Монетизация: 1 голос за "Превратить все" =====
const PRODUCT_ID = 'convert_all_1'; // Создайте такой товар в Платежах VK

function convertAllSnowflakes() {
  for (let i = snow.length - 1; i >= 0; i--) {
    const s = snow[i];
    hearts.push({ x: s.x, y: Math.min(s.y, H-24), vy: -1.2, size: s.size*2.1, life: 0 });
  }
  snow.length = 0;
  hapticSuccess();
}

document.getElementById('payAllBtn').addEventListener('click', async () => {
  try {
    await bridge.send('VKWebAppShowOrderBox', { type: 'item', item: PRODUCT_ID });
  } catch (_) { /* ждём события через subscribe */ }
});

bridge.subscribe(({ detail }) => {
  const { type } = detail || {};
  if (type === 'VKWebAppOrderSuccess') convertAllSnowflakes();
  // Можно обрабатывать VKWebAppOrderFail / VKWebAppOrderCancel
});

// Пауза при сворачивании WebView
bridge.subscribe((e) => {
  const { type } = e.detail || {}; 
  if(type === 'VKWebAppViewHide') window.__paused = true;
  if(type === 'VKWebAppViewRestore') window.__paused = false;
});
