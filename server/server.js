import express from 'express';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
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
const DEBUG_PAY_LOG = process.env.DEBUG_PAY_LOG === '1';
app.all('/api/payments/callback', (req, res, next) => {
  //if (DEBUG_PAY_LOG) {
    const body = req.method === 'GET' ? req.query : req.body;
    console.log('[VK PAY][REQ]', req.method, body);
  //}
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

// ===== Payments Callback =====
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
        return res.json({ error: { error_code: 20, error_msg: 'Item not found' } });
      }
      const payload = { response: { item_id: product.item_id, title: product.title, price: product.price } };
      console.log('[VK PAY][RES]', 200, payload);
      return res.json(payload);

    }

    if (type === 'order_status_change' || type === 'order_status_change_test') {
      const status = body.status;
      const order_id = body.order_id;
      if (status === 'chargeable') {
        const appOrderId = `${Date.now()}_${order_id}`;
        const payload = { response: { order_id: Number(order_id), app_order_id: String(appOrderId) } };
        console.log('[VK PAY][RES]', 200, payload);
        return res.json(payload);
      }
      // paid / cancel / other — acknowledge
      const payload = { response: 1 };
      console.log('[VK PAY][RES]', 200, payload);
      return res.json(payload);
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
const DEBUG_OK_LOG = process.env.DEBUG_OK_LOG === '1';
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
app.all(['/api/ok/callback', '/api/payments/callback'], async (req, res) => {
  try {
    if (OK_ENFORCE_GET && req.method !== 'GET') {
      res.set('Invocation-error', '104'); // Using 104 as generic error per docs
      return res.status(405).json(okJsonError(104, 'Only GET is allowed by OK docs'));
    }

    const body = req.method === 'GET' ? req.query : (req.body || {});
    if (DEBUG_OK_LOG) console.log('[OK PAY][REQ]', req.method, body);

    const { OK_SECRET_KEY = '' } = process.env;
    if (!OK_SECRET_KEY) {
      res.set('Invocation-error', '2');
      return res.status(500).json(okJsonError(2, 'SERVICE : OK secret missing'));
    }

    // signature
    if (!okCheckSig(body, OK_SECRET_KEY)) {
      if (DEBUG_OK_LOG) console.log('[OK PAY] sig mismatch', body);
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
    console.log('[OK PAY][RES]', 200, true);
    return res.status(200).send(true);
  } catch (e) {
    console.error('[OK PAY] callback error', e);
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
