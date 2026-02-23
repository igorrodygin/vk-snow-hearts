import express from 'express';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // VK sends x-www-form-urlencoded

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ===== Simple persistent store (idempotency for VK payment callbacks) =====
// VK can resend the *same* notification. For order_status_change повторный ответ
// должен быть идентичным для того же order_id. Аналогично для subscription_status_change
// — для того же subscription_id.
const STORE_PATH = path.join(__dirname, 'payments-store.json');

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {}
  return { nextAppOrderId: 1000, orders: {}, subscriptions: {} };
}

const STORE = loadStore();

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(STORE, null, 2), 'utf8');
  } catch (e) {
    console.error('[STORE] failed to save', e);
  }
}

function allocAppOrderId() {
  const id = Number(STORE.nextAppOrderId || 1000);
  STORE.nextAppOrderId = id + 1;
  return id;
}

function getOrCreateOrderReply(orderId) {
  const key = String(orderId);
  if (STORE.orders[key]) return STORE.orders[key];
  const reply = { order_id: Number(orderId), app_order_id: allocAppOrderId() };
  STORE.orders[key] = reply;
  saveStore();
  return reply;
}

function getOrCreateSubscriptionReply(subscriptionId) {
  const key = String(subscriptionId);
  if (STORE.subscriptions[key]) return STORE.subscriptions[key];
  const reply = { subscription_id: Number(subscriptionId), app_order_id: allocAppOrderId() };
  STORE.subscriptions[key] = reply;
  saveStore();
  return reply;
}

// ===== Helpers =====
function base64url(input){return input.replace(/\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}
function verifyVKSign(query, secret){
  const sign = query.sign;
  if(!sign) return false;
  const params = Object.keys(query)
    .filter(k => k.startsWith('vk_'))
    .sort()
    .map(k => `${k}=${query[k]}`)
    .join('&');
  const hash = crypto.createHmac('sha256', secret).update(params).digest('base64');
  return base64url(hash) === sign;
}

// ---- Tolerant VK Payments signature check (MD5) ----
function vkPaymentsCheckSig(params, appSecret) {
  const entries = Object.keys(params)
    .filter(k => k !== 'sig')
    .sort()
    .map(k => `${k}=${params[k]}`);

  const sig = String(params.sig || '').toLowerCase();

  // A) classic (no separators)
  const plain = entries.join('') + appSecret;
  const md5Plain = crypto.createHash('md5').update(plain).digest('hex');
  if (md5Plain === sig) return true;

  // B) docs variant (&-joined)
  const amp = entries.join('&') + appSecret;
  const md5Amp = crypto.createHash('md5').update(amp).digest('hex');
  if (md5Amp === sig) return true;

  return false;
}

// ===== Debug logging (remove after debug) =====
const DEBUG_PAY_LOG = process.env.DEBUG_PAY_LOG === '0';
app.all('/api/payments/callback', (req, res, next) => {
  if (DEBUG_PAY_LOG) {
    const body = req.method === 'GET' ? req.query : req.body;
    console.log('[VK PAY][REQ]', req.method, body);
  }
  next();
});

// ===== Catalog for get_item =====
const CATALOG = {
  convert_all_1: {
    item_id: 'convert_all_1',
    title: 'Превратить все снежинки',
    price: 1
  }
};

// ===== Subscriptions catalog for get_subscription =====
// period: возможные значения 3/7/30 дней (для 1 месяца — 30).
const SUBSCRIPTIONS = {
  // 1 месяц за 2 голоса (возобновляемая подписка)
  subscription_1m_2_votes: {
    item_id: 'subscription_1m_2_votes',
    title: 'Подписка на 1 месяц',
    price: 2,
    period: 30,
    // trial_duration: 3,
    // expiration: 600,
  }
};

function fullHttpLogger(req, res, next) {
  const start = Date.now();

  console.log('\n==================== HTTP IN ====================');
  console.log('TIME:   ', new Date().toISOString());
  console.log('REMOTE: ', req.ip);
  console.log('METHOD: ', req.method);
  console.log('URL:    ', req.originalUrl);
  console.log('HEADERS:', req.headers);
  console.log('QUERY:  ', req.query);
  console.log('BODY:   ', req.body);

  if (req.rawBody) {
    console.log('RAWBODY:', req.rawBody.toString('utf8'));
  } else {
    console.log('RAWBODY: <no rawBody captured>');
  }

  // --- capture response ---
  const chunks = [];
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);

  res.write = (chunk, encoding, cb) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return origWrite(chunk, encoding, cb);
  };

  res.end = (chunk, encoding, cb) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return origEnd(chunk, encoding, cb);
  };

  res.on('finish', () => {
    const ms = Date.now() - start;
    const body = Buffer.concat(chunks).toString('utf8');

    console.log('==================== HTTP OUT ===================');
    console.log('TIME:   ', new Date().toISOString());
    console.log('STATUS: ', res.statusCode);
    console.log('HEADERS:', res.getHeaders());
    console.log('BODY:   ', body);
    console.log('DUR_MS: ', ms);
    console.log('=================================================\n');
  });

  next();
}

// ===== Payments Callback =====
app.use(['/api/payments/callback'], fullHttpLogger);
app.all('/api/payments/callback', async (req, res) => {
  try {
    const body = req.method === 'GET' ? req.query : req.body;
    const { VK_APP_SECRET } = process.env;

    if (!vkPaymentsCheckSig(body, VK_APP_SECRET)) {
      if (DEBUG_PAY_LOG) {
        console.log('[VK PAY] sig mismatch, body=', body);
      }
      return res.status(403).send('sig mismatch');
    }

    const type = body.notification_type;

    if (type === 'get_item' || type === 'get_item_test') {
      const itemId = body.item || body.item_id;
      const product = CATALOG[itemId];
      if (!product) {
        return res.json({ error: { error_code: 20, error_msg: 'Product does not exist', critical: true } });
      }
      const payload = { response: { item_id: product.item_id, title: product.title, price: product.price } };
      //console.log('[VK PAY][RES]', 200, payload);
      return res.json(payload);

    }

    if (type === 'get_subscription' || type === 'get_subscription_test') {
      // VK sends subscription item name in `item` (client-controlled).
      const itemId = body.item || body.item_id;
      const sub = SUBSCRIPTIONS[itemId];
      if (!sub) {
        return res.json({ error: { error_code: 20, error_msg: 'Subscription does not exist', critical: true } });
      }

      const response = {
        // NOTE: VK docs often show item_id as int, но на практике можно не передавать.
        // Мы оставляем строковый идентификатор, чтобы легко сопоставлять с app-логикой.
        item_id: sub.item_id,
        title: sub.title,
        price: sub.price,
        period: sub.period,
      };
      if (sub.trial_duration) response.trial_duration = sub.trial_duration;
      if (sub.expiration !== undefined) response.expiration = sub.expiration;

      return res.json({ response });
    }

    if (type === 'order_status_change' || type === 'order_status_change_test') {
      const status = body.status;
      const order_id = body.order_id;
      if (status === 'chargeable') {
        // Must be idempotent for the same order_id.
        const reply = getOrCreateOrderReply(order_id);
        const payload = { response: reply };
        //console.log('[VK PAY][RES]', 200, payload);
        return res.json(payload);
      }
      // paid / cancel / other — acknowledge
      const payload = { response: 1 };
      //console.log('[VK PAY][RES]', 200, payload);
      return res.json(payload);
    }

    if (type === 'subscription_status_change' || type === 'subscription_status_change_test') {
      const status = body.status;
      const subscription_id = body.subscription_id;

      if (subscription_id === undefined || subscription_id === null || subscription_id === '') {
        return res.json({ error: { error_code: 11, error_msg: 'Bad request: missing subscription_id', critical: true } });
      }

      // Defensive checks against tampering
      const itemId = body.item_id;
      const sub = SUBSCRIPTIONS[itemId];
      if (!sub) {
        return res.json({ error: { error_code: 20, error_msg: 'Subscription does not exist', critical: true } });
      }
      const price = Number(body.item_price);
      if (Number.isFinite(price) && price !== Number(sub.price)) {
        return res.json({ error: { error_code: 11, error_msg: 'Bad request: item_price mismatch', critical: true } });
      }

      // For chargeable we MUST return subscription_id + app_order_id,
      // and response must be identical if VK resends the same notification.
      if (status === 'chargeable') {
        const reply = getOrCreateSubscriptionReply(subscription_id);
        return res.json({ response: reply });
      }

      // For active/cancelled we acknowledge and also return subscription_id
      // (safe, and helps debugging/logging).
      const known = STORE.subscriptions[String(subscription_id)];
      const response = { subscription_id: Number(subscription_id) };
      if (known && known.app_order_id != null) response.app_order_id = known.app_order_id;
      return res.json({ response });
    }

    // Fallback OK
    return res.json({ response: 1 });
  } catch (e) {
    console.error('[VK PAY] callback error', e);
    return res.status(500).send('server error');
  }
});

// ===== Client verify via orders.getById =====
app.post('/api/orders/verify', async (req,res)=>{
  try{
    const { app_order_id, item_id, vk_params } = req.body||{};
    if(!app_order_id) return res.status(400).json({ok:false,error:'no_order'});
    const { VK_APP_SECRET, VK_SERVICE_TOKEN, VK_API_VERSION='5.131', VERIFY_SIGN='true', VK_TEST_PAY='0' }=process.env;
    if(VERIFY_SIGN==='true' && (!vk_params || !verifyVKSign(vk_params,VK_APP_SECRET))) return res.status(403).json({ok:false,error:'bad_sign'});
    const params = new URLSearchParams({v:VK_API_VERSION,access_token:VK_SERVICE_TOKEN,order_id:String(app_order_id)});
    if(VK_TEST_PAY==='1') params.set('test_mode','1');
    const r = await fetch('https://api.vk.com/method/orders.getById?'+params.toString());
    const j = await r.json();
    const o = j.response && (j.response[0]||j.response);
    if(!o) return res.status(404).json({ok:false,error:'not_found'});
    if(o.status==='charged' && (!item_id || o.item===item_id) && o.amount>=1) return res.json({ok:true});
    return res.status(409).json({ok:false,error:'not_charged',o});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'server'});}
});


// ===== Odnoklassniki (OK) Payments — callbacks.payment =====
// Docs: https://apiok.ru/dev/methods/rest/callbacks/callbacks.payment
// Works via HTTP GET (per docs), but we accept ALL to be safe and parse from query/body.
// Response MUST be application/json or application/xml; we return JSON.
// OK will retry up to 3 times if non-200 or invalid response.
const DEBUG_OK_LOG = process.env.DEBUG_OK_LOG === '0';
const OK_ENFORCE_GET = process.env.OK_ENFORCE_GET === '0'; // set to '1' to enforce GET-only

// Compute signature: sig = MD5( concat(sorted key=value, without 'sig') + OK_SECRET_KEY )
function okCheckSig(params, secret) {
  const parts = Object.keys(params)
    .filter(k => k !== 'sig')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('');
  const md5 = crypto.createHash('md5').update(parts + secret).digest('hex');
  return md5 === String(params.sig || '').toLowerCase();
}

// Simple catalog check (map OK product_code to our items/prices in OKs)
const OK_CATALOG = {
  convert_all_1: { price: 1, title: 'Превратить все снежинки' }
};

function okJsonError(code, msg) {
  // Per docs, error payload shape:
  // { "error_code": <int>, "error_msg": "<text>", "error_data": null }
  return { error_code: code, error_msg: msg, error_data: null };
}

// Endpoint for OK callbacks (OK может вызывать и /api/payments/callback)
app.use(['/api/ok/callback', '/api/payments/callback'], fullHttpLogger);
app.all(['/api/ok/callback', '/api/payments/callback'], async (req, res) => {
  try {
    if (OK_ENFORCE_GET && req.method !== 'GET') {
      res.set('Invocation-error', '104'); // Using 104 as generic error per docs
      return res.status(405).json(okJsonError(104, 'Only GET is allowed by OK docs'));
    }

    const body = req.method === 'GET' ? req.query : (req.body || {});
    //if (DEBUG_OK_LOG) console.log('[OK PAY][REQ]', req.method, body);

    const { OK_SECRET_KEY = '' } = process.env;
    if (!OK_SECRET_KEY) {
      res.set('Invocation-error', '2');
      return res.status(500).json(okJsonError(2, 'SERVICE : OK secret missing'));
    }

    // signature
    if (!okCheckSig(body, OK_SECRET_KEY)) {
      //if (DEBUG_OK_LOG) console.log('[OK PAY] sig mismatch', body);
      res.set('Invocation-error', '104');
      return res.status(403).json(okJsonError(104, 'PARAM_SIGNATURE : Invalid signature'));
    }

    // required fields (per docs). Some subscription events may lack transaction_id.
    const uid = body.uid;
    const transaction_id = body.transaction_id || '';
    const amount = Number(body.amount || 0);
    const product_code = body.product_code || '';
    const transaction_time = body.transaction_time || '';

    // Optional: validate catalog & price match to prevent tampering
    if (product_code) {
      const product = OK_CATALOG[product_code];
      if (!product) {
        res.set('Invocation-error', '1001');
        return res.status(400).json(okJsonError(1001, 'CALLBACK_INVALID_PAYMENT : Unknown product_code'));
      }
      if (Number.isFinite(product.price) && amount == Number(product.price)) {
        res.set('Invocation-error', '1001');
        return res.status(400).json(okJsonError(1001, 'CALLBACK_INVALID_PAYMENT : Amount mismatch'));
      }
    }

    // Success confirmation
    res.type('application/json');
    //console.log('[OK PAY][RES]', 200, true);
    return res.status(200).send(true);
  } catch (e) {
    //console.error('[OK PAY] callback error', e);
    res.set('Invocation-error', '9999');
    return res.status(500).json(okJsonError(9999, 'SYSTEM : server error'));
  }
});

// ===== Static & health =====
app.use(express.static(PUBLIC_DIR,{maxAge:'1h',index:false}));
app.get('/',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));
app.get('/health',(_,res)=>res.json({ok:true}));

const PORT=process.env.PORT||8080;
app.listen(PORT,()=>console.log('Server listening on :'+PORT));

// --- ЛОГИРОВАНИЕ РЕКЛАМЫ ---
app.use(express.json()); // если уже есть — второй раз не добавляй

app.post('/log', (req, res) => {
  console.log('[AD]', req.body); // смотри тут всё, что прилетает с клиента
  res.sendStatus(204);
});
