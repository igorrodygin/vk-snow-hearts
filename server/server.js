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
app.use(express.urlencoded({ extended: true })); // for VK payments form POST

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// helpers
function base64url(input){return input.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function verifyVKSign(query, secret){const sign=query.sign;if(!sign)return false;const params=Object.keys(query).filter(k=>k.startsWith('vk_')).sort().map(k=>`${k}=${query[k]}`).join('&');const hash=crypto.createHmac('sha256',secret).update(params).digest('base64');return base64url(hash)===sign;}
function vkPaymentsCheckSig(params, appSecret) { const sorted = Object.keys(params).filter(k => k !== 'sig').sort().map(k => `${k}=${params[k]}`).join('&'); const md5 = crypto.createHash('md5').update(sorted + appSecret).digest('hex'); return md5 === String(params.sig || '').toLowerCase(); }

// catalog for get_item
const CATALOG = { convert_all_1: { item_id: 'convert_all_1', title: 'Превратить все снежинки', price: 1 } };

// Accept both POST and GET to avoid 405
app.all('/api/payments/callback', async (req, res) => {
  try {
    const body = req.method === 'GET' ? req.query : req.body;
    const { VK_APP_SECRET } = process.env;
    //if (!vkPaymentsCheckSig(body, VK_APP_SECRET)) return res.status(403).send('sig mismatch');
    if (process.env.DISABLE_SIG_CHECK !== 'true' && !vkPaymentsCheckSig(body, VK_APP_SECRET)) {
      return res.status(403).send('sig mismatch');
    }


    const type = body.notification_type;

    if (type === 'get_item_test') {
      const itemId = body.item || body.item_id;
      const product = CATALOG[itemId];
      if (!product) return res.json({ error: { error_code: 20, error_msg: 'Item not found' } });
      return res.json({ response: { item_id: product.item_id, title: product.title, price: product.price } });
    }

    if (type === 'get_item') {
      const itemId = body.item || body.item_id;
      const product = CATALOG[itemId];
      if (!product) return res.json({ error: { error_code: 20, error_msg: 'Item not found' } });
      return res.json({ response: { item_id: product.item_id, title: product.title, price: product.price } });
    }

    if (type === 'order_status_change') {
      const status = body.status;
      const order_id = body.order_id;
      if (status === 'chargeable') {
        const appOrderId = `${Date.now()}_${order_id}`;
        return res.json({ response: { order_id: Number(order_id), app_order_id: String(appOrderId) } });
      }
      return res.json({ response: 1 });
    }

    if (type === 'order_status_change_test') {
      const status = body.status;
      const order_id = body.order_id;
      if (status === 'chargeable') {
        const appOrderId = `${Date.now()}_${order_id}`;
        return res.json({ response: { order_id: Number(order_id), app_order_id: String(appOrderId) } });
      }
      return res.json({ response: 1 });
    }

    return res.json({ response: 1 });
  } catch (e) {
    console.error('callback error', e);
    return res.status(500).send('server error');
  }
});

// verify via orders.getById
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

// static + health
app.use(express.static(PUBLIC_DIR,{maxAge:'1h',index:false}));
app.get('/',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));
app.get('/health',(_,res)=>res.json({ok:true}));

const PORT=process.env.PORT||8080;
app.listen(PORT,()=>console.log('Server listening on :'+PORT));
