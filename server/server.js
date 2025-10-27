import express from 'express';
import path from 'path';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(compression());

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function base64url(input){return input.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function verifyVKSign(query, secret){
  const sign=query.sign; if(!sign) return false;
  const params=Object.keys(query).filter(k=>k.startsWith('vk_')).sort().map(k=>`${k}=${query[k]}`).join('&');
  const hash=crypto.createHmac('sha256',secret).update(params).digest('base64');
  return base64url(hash)===sign;
}

app.get('/',(req,res)=>{
  const { VERIFY_SIGN='false', VK_APP_SECRET }=process.env;
  if(VERIFY_SIGN.toLowerCase()==='true'&&!verifyVKSign(req.query,VK_APP_SECRET))
    return res.status(403).send('Forbidden: invalid VK Mini Apps signature');
  return res.sendFile(path.join(PUBLIC_DIR,'index.html'));
});
app.use(express.static(PUBLIC_DIR,{maxAge:'1h',index:false}));
app.get('/health',(_,res)=>res.json({ok:true}));
const PORT=process.env.PORT||8080;
app.listen(PORT,()=>console.log(`Server listening on :${PORT}`));
