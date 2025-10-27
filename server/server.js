import express from 'express';
import path from 'path';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function base64url(input){return input.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function verifyVKSign(query, secret){const sign=query.sign;if(!sign)return false;const params=Object.keys(query).filter(k=>k.startsWith('vk_')).sort().map(k=>`${k}=${query[k]}`).join('&');const hash=crypto.createHmac('sha256',secret).update(params).digest('base64');return base64url(hash)===sign;}

// Verify endpoint
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

// Static
app.use(express.static(PUBLIC_DIR,{maxAge:'1h',index:false}));
app.get('/',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

const PORT=process.env.PORT||8080;
app.listen(PORT,()=>console.log('Server listening on :'+PORT));
