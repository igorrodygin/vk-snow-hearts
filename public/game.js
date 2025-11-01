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
  for(let i = snow.length - 1; i >= 0; i--){
    const s = snow[i];
    s.vy = (s.vy || 0) + gravity * dt;
    s.vx = (s.vx || 0) + rand(-0.02, 0.02) * dt;
    s.x += s.vx * dt * 60;
    s.y += s.vy * dt * 60;

    // если снежинка достигла земли — превращаем её в сердечко БЕЗ хаптика
    if (s.y >= H - 20) {
      hearts.push({ x: s.x, y: H - 24, vy: rand(-1.4, -0.8), size: s.size * 2.2, life: 0 });
      snow.splice(i, 1);
      // hapticImpact('light');  <-- УДАЛЕНО
    }
    else if (s.x < -20 || s.x > W + 20 || s.y > H + 40) {
      snow.splice(i, 1);
    }
  }

  for (let i = hearts.length - 1; i >= 0; i--) {
    const h = hearts[i];
    h.y += h.vy * dt * 60;
    h.vy += 0.02 * dt;
    h.life += dt;
    if (h.life > 2.5) hearts.splice(i, 1);
  }
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
/* haptic removed: non-tap */
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
/* haptic removed: non-tap */
  }
});

bridge.subscribe(async ({ detail }) => {
  const { type, data } = detail || {};

if (type === 'VKWebAppShowOrderBoxResult') {
  console.log('✅ Покупка успешна, order_id:', data.order_id);
  convertAllSnowflakes(); // сразу превращаем снежинки
} else {
/* haptic removed: non-tap */
}
  if (type === 'VKWebAppShowOrderBoxFailed') {
    console.error('⚠️ ShowOrderBoxFailed:', data);  // один понятный лог
/* haptic removed: non-tap */
  }
});


// ===== Banner Ads (periodic bottom) =====
(function(){
  const BANNER_POSITION = 'bottom';             // снизу
  const FIRST_SHOW_DELAY_MS = 7000;             // первый показ через 7 секунд «игры»
  const PERIODIC_INTERVAL_MS = 15000;           // далее — каждые 15 секунд
  let bannerVisible = false;
  let bannerHeight = 0;
  let started = false;
  let firstTimer = null;
  let periodicTimer = null;
  let closedByUser = false;

  function applyBannerInsets(){
    const root = document.documentElement;
    if (BANNER_POSITION === 'bottom') {
      root.style.setProperty('--banner-bottom-inset', bannerVisible ? (bannerHeight + 'px') : '0px');
    } else {
      root.style.setProperty('--banner-top-inset', bannerVisible ? (bannerHeight + 'px') : '0px');
    }
  }

  async function checkBannerAvailable(){
    try {
      if (await bridgeSupports('VKWebAppCheckBannerAd')) {
        const res = await bridge.send('VKWebAppCheckBannerAd', { banner_location: BANNER_POSITION });
        return !!res?.result;
      }
      // если нет метода проверки — пробуем показать вслепую
      return true;
    } catch(e){
      console.debug('CheckBannerAd error', e);
      return false;
    }
  }

  async function showBannerOnce() {
/*     // ✅ Показываем баннер ТОЛЬКО если метод поддерживается
    if (!(await bridgeSupports('VKWebAppShowBannerAd'))) return false; */

    try {
      const res = await bridge.send('VKWebAppShowBannerAd', {
        banner_location: BANNER_POSITION,
      });

      console.log('VKWebAppShowBannerAd result:', res);

      if (res?.result) {
        bannerVisible = true;
        closedByUser = false;
        applyBannerInsets();
        return true;
      }
    } catch (e) {
      console.warn('VKWebAppShowBannerAd error:', e);
    }
    return false;
  }


  async function ensureBanner(){
    if (closedByUser) return false; // уважаем решение пользователя
    if (bannerVisible) { applyBannerInsets(); return true; }
 /*    const available = await checkBannerAvailable();
    if (!available) return false; */
    return await showBannerOnce();
  }

  function startPeriodicFlow(){
    // первый показ через 7 секунд
    clearTimeout(firstTimer);
    firstTimer = setTimeout(async () => {
      await ensureBanner().catch(()=>{});
      // далее — каждые 15 секунд лёгкая попытка (если уже показан — просто поддерживаем инсет)
      clearInterval(periodicTimer);
      periodicTimer = setInterval(() => { ensureBanner().catch(()=>{}); }, PERIODIC_INTERVAL_MS);
    }, FIRST_SHOW_DELAY_MS);
  }

  function markGameStarted(){
    if (started) return;
    started = true;
    startPeriodicFlow();
  }

  // события баннера
  bridge.subscribe(({ detail }) => {
    const { type, data } = detail || {};
    if (type === 'VKWebAppBannerAdUpdated'){
      if (typeof data?.height === 'number'){
        bannerHeight = data.height;
        bannerVisible = true;
        applyBannerInsets();
      }
    }
    if (type === 'VKWebAppBannerAdClosedByUser'){
      bannerVisible = false;
      bannerHeight = 0;
      closedByUser = true;
      applyBannerInsets();
    }
  });

  // запускаем «начало игры» при первом взаимодействии с канвасом,
  // чтобы таймеры шли именно по времени игры
  try {
    const canvas = document.getElementById('game');
    if (canvas){
      const kickoff = () => { markGameStarted(); canvas.removeEventListener('pointerdown', kickoff); canvas.removeEventListener('touchstart', kickoff, { passive:true }); canvas.removeEventListener('click', kickoff); };
      canvas.addEventListener('pointerdown', kickoff);
      canvas.addEventListener('touchstart', kickoff, { passive:true });
      canvas.addEventListener('click', kickoff);
    } else {
      // на всякий случай — фоллбек через 7 секунд после загрузки
      setTimeout(markGameStarted, 7000);
    }
  } catch(e){
    // если что-то пошло не так — не блокируем игру
    setTimeout(markGameStarted, 7000);
  }
})();
// ===== /Banner Ads =====


// ===== Subscription test button (VKWebAppShowSubscriptionBox) =====
(function(){
  const method = 'VKWebAppShowSubscriptionBox';
  const btn = document.getElementById('subBtn');
  const sel = document.getElementById('subAction');
  const inputId = document.getElementById('subId');

  function log(...args){ try { console.log('[SUB]', ...args); } catch(e){} }

  if (!btn) { log('no #subBtn found in DOM'); return; }

  btn.addEventListener('click', async () => {
    const supported = !!(bridge && bridge.supports && bridge.supports(method));
    const action = (sel && sel.value) || 'create';
    const subscription_id = (inputId && inputId.value.trim()) || undefined;

    // ✅ Обязательные параметры для теста подписки
    const params = {
      action,                                // create / cancel
      item: 'subscription_convert_all_1',    // идентификатор подписки
    };
    if (subscription_id) params.subscription_id = subscription_id;

    log('click ->', method, 'supported=', supported, 'params=', params);
    try {
      const res = await bridge.send(method, params);
      log('result:', res);
      alert('VKWebAppShowSubscriptionBox result: ' + JSON.stringify(res));
    } catch (err) {
      log('error:', err);
      const detail = err && (err.error_data || err.data || err.message || err.toString());
      alert('VKWebAppShowSubscriptionBox error: ' + JSON.stringify(detail));
    }
  });
})();
// ===== /Subscription test =====
