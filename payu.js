// Monster Merge PayU checkout. Keys/salt stay in Render environment variables.
const crypto = require('node:crypto');
const express = require('express');

const PACKS = Object.freeze([
  {id:'starter',title:'Starter',coins:500,amountPaise:4900,currency:'INR'},
  {id:'adventurer',title:'Adventurer',coins:1500,amountPaise:12900,currency:'INR'},
  {id:'champion',title:'Champion',coins:4000,amountPaise:29900,currency:'INR'},
  {id:'legend',title:'Legend',coins:10000,amountPaise:64900,currency:'INR'}
]);
class PaymentError extends Error {
  constructor(status,code,message) { super(message); this.status=status; this.code=code; }
}
const fail = (status,code,message) => { throw new PaymentError(status,code,message); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sha512 = value => crypto.createHash('sha512').update(value).digest('hex');
const money = paise => (paise/100).toFixed(2);
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const object = value => value && typeof value==='object' && !Array.isArray(value);
function toPaise(value) {
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(value))) fail(409,'payment_mismatch','Invalid payment amount.');
  const [whole,fraction=''] = String(value).split('.');
  const amount = Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if (!Number.isSafeInteger(amount)) fail(409,'payment_mismatch','Invalid payment amount.');
  return amount;
}
function paymentHash(fields,salt) {
  const names=['key','txnid','amount','productinfo','firstname','email','udf1','udf2','udf3','udf4','udf5'];
  return sha512([...names.map(k=>fields[k]||''),'','','','','',salt].join('|'));
}
function responseHash(fields,salt) {
  const values=[salt,fields.status||'','','','','','',...['udf5','udf4','udf3','udf2','udf1','email','firstname','productinfo','amount','txnid','key'].map(k=>fields[k]||'')];
  const extra=fields.additionalCharges ?? fields.additional_charges;
  if (extra!==undefined) values.unshift(extra);
  return sha512(values.join('|'));
}
function configuration(env) {
  const mode=env.PAYMENT_MODE||'test';
  if (!['test','live'].includes(mode)) throw new Error('PAYMENT_MODE must be test or live');
  const publicUrl=(env.PAYU_PUBLIC_URL||env.PUBLIC_URL||'').replace(/\/$/,'');
  if (publicUrl) {
    const url=new URL(publicUrl);
    if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash)
      throw new Error('PAYU_PUBLIC_URL must be an HTTPS origin');
  }
  const requested=env.PAYMENTS_ENABLED==='true';
  if (requested && mode==='live' && env.ALLOW_LIVE_PAYMENTS!=='true') throw new Error('Live payments require ALLOW_LIVE_PAYMENTS=true');
  const key=env.PAYU_KEY||'', salt=env.PAYU_SALT||'';
  if (/[|\x00-\x1f]/.test(key+salt)) throw new Error('Invalid PayU credentials');
  return {mode,publicUrl,key,salt,enabled:!!(requested&&publicUrl&&key&&salt),
    checkoutUrl:mode==='test'?'https://test.payu.in/_payment':'https://secure.payu.in/_payment',
    verifyUrl:mode==='test'?'https://test.payu.in/merchant/postservice.php?form=2':'https://info.payu.in/merchant/postservice.php?form=2'};
}
function page(title,body) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Monster Merge - PayU</title>
  <style>*{box-sizing:border-box}body{background:#f0f3f7;color:#172635;font:15px system-ui;margin:0;padding:20px}main{max-width:470px;margin:3vh auto;padding:28px;background:white;border:1px solid #dde4eb;border-radius:20px;box-shadow:0 16px 50px #1726350d}header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e6ebf0;padding-bottom:20px}small{font-weight:750;letter-spacing:1px}header span{color:#47716a;font-size:12px}h1{font-size:27px;letter-spacing:-.7px;margin:24px 0 10px}h2{font-size:28px;margin:6px 0}label{display:block;margin:18px 0;font-weight:600;font-size:13px}input,button{width:100%;padding:14px;border-radius:9px;border:1px solid #cbd5df;margin-top:7px;font:16px system-ui}input:focus{outline:2px solid #198772;outline-offset:2px}button{background:#146f5c;color:white;border:0;font-weight:700;cursor:pointer;min-height:52px}button:hover{background:#105a4b}p{line-height:1.6;color:#617081;font-size:13px}.summary{background:#f6f8fb;border:1px solid #e2e8ef;padding:18px;border-radius:12px;margin:18px 0}.line{display:flex;justify-content:space-between;gap:12px;margin:9px 0}.total{border-top:1px solid #dae1e9;padding-top:13px;font-size:20px;font-weight:750}.mode{padding:10px 12px;background:#fff4d5;color:#755509;border:1px solid #efda9d;border-radius:8px;font-size:12px;font-weight:700}.steps{color:#678075;font-size:12px;margin:20px 0}.reference{overflow-wrap:anywhere;font-size:11px;color:#788695}footer{border-top:1px solid #e6ebf0;margin-top:22px;padding-top:14px;font-size:11px;line-height:1.7;color:#788695}@media(max-width:400px){body{padding:10px}main{padding:20px;margin:1vh auto}}</style>
  <main><header><small>MONSTER MERGE</small><span>Coin purchase</span></header><h1>${escape(title)}</h1>${body}<footer>Payment details are entered on PayU's hosted checkout. Coins are added only after the game server verifies the payment.</footer></main></html>`;
}

function modelsFor(connection,mode) {
  const Schema=connection.base.Schema;
  const prefix='monster_payu_'+mode;
  const model=(name,schema)=>connection.models[prefix+name]||connection.model(prefix+name,schema,prefix+'_'+name);
  const account=new Schema({_id:String,tokenHash:{type:String,unique:true,required:true},
    googleUserId:{type:String,index:true},creditedCoinsTotal:{type:Number,default:0},created:Number},{versionKey:false});
  const order=new Schema({_id:String,accountId:{type:String,required:true},requestId:String,packId:String,
    coins:Number,amountPaise:Number,currency:String,receipt:String,
    checkoutToken:{type:String,unique:true,required:true},created:Number,expires:Number,
    status:{type:String,default:'pending'},paymentId:String,lastChecked:{type:Number,default:0},
    customer:{firstname:String,email:String,phone:String}},{versionKey:false});
  order.index({accountId:1,requestId:1},{unique:true});
  order.index({accountId:1,status:1,lastChecked:1});
  const credit=new Schema({_id:String,paymentId:{type:String,unique:true,required:true},accountId:String,coins:Number,created:Number},{versionKey:false});
  return {Account:model('accounts',account),Order:model('orders',order),Credit:model('credits',credit)};
}

class PayUService {
  constructor({connection,config,fetchImpl=globalThis.fetch,now=Date.now}) {
    this.connection=connection;this.config=config;this.fetch=fetchImpl;this.now=now;
    Object.assign(this,modelsFor(connection,config.mode));
  }
  async initialize() { await Promise.all([this.Account.init(),this.Order.init(),this.Credit.init()]); }
  requireEnabled() { if (!this.config.enabled) fail(503,'payments_unavailable','Coin payments are not available yet.'); }
  catalog() { return {provider:'payu',requiresGoogleLogin:true,packs:PACKS,testMode:this.config.mode==='test',enabled:this.config.enabled}; }
  async createAccount(googleUserId) {
    if (!googleUserId) fail(401,'google_login_required','Sign in with Google to purchase.');
    const accountId='acct_'+crypto.randomBytes(16).toString('hex'),token=crypto.randomBytes(48).toString('base64url');
    await this.Account.create({_id:accountId,tokenHash:digest(token),googleUserId,created:this.now()});
    return {accountId,token};
  }
  async authenticate(header) {
    if (typeof header!=='string' || !/^Bearer [A-Za-z0-9_-]{64}$/.test(header)) fail(401,'unauthorized','Invalid payment account.');
    const account=await this.Account.findOne({tokenHash:digest(header.slice(7))}).lean();
    if (!account) fail(401,'unauthorized','Invalid payment account.');
    return account._id;
  }
  async linkAccount(accountId,googleUserId) {
    const linked=await this.Account.findOneAndUpdate({_id:accountId,$or:[{googleUserId:{$exists:false}},{googleUserId}]},
      {$set:{googleUserId}},{new:true}).lean();
    if(!linked) fail(403,'account_mismatch','This payment account belongs to another Google account.');
    return {accountId:linked._id};
  }
  async authorizeAccount(accountId,googleUserId) {
    if(!googleUserId || !await this.Account.exists({_id:accountId,googleUserId}))
      fail(403,'account_mismatch','Sign in with the Google account linked to this save.');
    return accountId;
  }
  async storedOrder(id,owner) {
    if (typeof id!=='string'||!/^order_[a-f0-9]{18}$/.test(id)) fail(404,'order_not_found','Order not found.');
    const row=await this.Order.findById(id).lean();
    if (!row || (owner && row.accountId!==owner)) fail(404,'order_not_found','Order not found.');
    return row;
  }
  async response(row) {
    const account=await this.Account.findById(row.accountId).lean();
    if (!account) fail(401,'unauthorized','Account not found.');
    const status=row.status==='pending'&&this.now()>=row.expires?'expired':row.status;
    return {orderId:row._id,status,coins:row.coins,amountPaise:row.amountPaise,currency:row.currency,
      creditedCoinsTotal:account.creditedCoinsTotal,
      checkoutUrl:status==='pending'?this.config.publicUrl+'/checkout/'+row.checkoutToken:''};
  }
  async createOrder(accountId,body) {
    this.requireEnabled();
    if (!object(body)||Object.keys(body).sort().join(',')!=='packId,requestId'||typeof body.packId!=='string'
        ||typeof body.requestId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(body.requestId))
      fail(400,'invalid_order','Choose a coin pack. Prices are set by the server.');
    const previous=await this.Order.findOne({accountId,requestId:body.requestId}).lean();
    if (previous) {
      if (previous.packId!==body.packId) fail(409,'request_conflict','This request belongs to another pack.');
      return this.response(previous);
    }
    const pack=PACKS.find(p=>p.id===body.packId);
    if (!pack) fail(400,'invalid_order','Choose an available coin pack.');
    try {
      const row=await this.Order.create({_id:'order_'+crypto.randomBytes(9).toString('hex'),accountId,
        requestId:body.requestId,packId:pack.id,coins:pack.coins,amountPaise:pack.amountPaise,currency:pack.currency,
        receipt:'mm_'+crypto.randomBytes(16).toString('hex'),checkoutToken:crypto.randomBytes(32).toString('base64url'),
        created:this.now(),expires:this.now()+1800000});
      return this.response(row.toObject());
    } catch(error) {
      if (error.code===11000) {
        const retry=await this.Order.findOne({accountId,requestId:body.requestId}).lean();
        if (retry && retry.packId===body.packId) return this.response(retry);
        fail(409,'request_conflict','Retry with the original purchase request.');
      }
      throw error;
    }
  }
  async checkoutOrder(token) {
    this.requireEnabled();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404,'checkout_not_found','Checkout link not found.');
    const row=await this.Order.findOne({checkoutToken:token}).lean();
    if (!row) fail(404,'checkout_not_found','Checkout link not found.');
    const account=await this.Account.findById(row.accountId).lean();
    if(!account?.googleUserId) fail(401,'google_login_required','Return to the game and sign in with Google before purchasing.');
    if (this.now()>=row.expires) fail(410,'checkout_expired','Checkout expired. Return to the game and refresh before trying again.');
    return row;
  }
  async checkoutHtml(token) {
    const row=await this.checkoutOrder(token);
    if (row.status==='paid') return page('Payment confirmed','<p>Return to the game and refresh your balance.</p>');
    return page(`${row.coins.toLocaleString('en-IN')} game coins`,
      `${this.config.mode==='test'?'<div class="mode">TEST MODE - no real money is charged</div>':'<p>One-time purchase through PayU</p>'}
      <div class="steps">1. Contact details &nbsp; / &nbsp; 2. PayU payment &nbsp; / &nbsp; 3. Coins delivered</div>
      <section class="summary"><div class="line"><span>Game coins</span><strong>${row.coins.toLocaleString('en-IN')}</strong></div><div class="line"><span>Purchase type</span><span>One-time coin pack</span></div><div class="line total"><span>Total</span><span>INR ${money(row.amountPaise)}</span></div></section>
      <p class="reference">Order reference: ${escape(row._id)}</p>
      <form method="post" action="/checkout/${escape(token)}/pay">
      <label>First name<input name="firstname" autocomplete="given-name" maxlength="60" required></label>
      <label>Email<input name="email" type="email" autocomplete="email" maxlength="120" required></label>
      <label>Phone<input name="phone" type="tel" autocomplete="tel" pattern="[+]?[0-9]{10,15}" required></label>
      <button>Continue to PayU</button></form><p>PayU needs your contact details for this purchase. Enter card or UPI details on PayU only.</p>
      <p>After payment, return to the game and refresh your balance. This purchase is linked to your signed-in account on this installation.</p>`);
  }
  async startCheckout(token,body) {
    let row=await this.checkoutOrder(token);
    if (row.status==='paid') return this.checkoutHtml(token);
    if (!object(body)) fail(400,'invalid_customer','Enter your contact details.');
    const customer={};
    for (const k of ['firstname','email','phone']) {
      if (typeof body[k]!=='string'||/[|\x00-\x1f]/.test(body[k])) fail(400,'invalid_customer','Enter valid contact details.');
      customer[k]=body[k].trim();
    }
    if (!customer.firstname || customer.firstname.length>60 || customer.email.length>120
        ||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)||!/^\+?[0-9]{10,15}$/.test(customer.phone))
      fail(400,'invalid_customer','Enter a first name, valid email and phone number.');
    await this.Order.updateOne({_id:row._id,customer:{$exists:false}},{$set:{customer}});
    row=await this.storedOrder(row._id);
    const fields={key:this.config.key,txnid:row._id,amount:money(row.amountPaise),productinfo:`${row.coins} game coins`,
      firstname:row.customer.firstname,email:row.customer.email,phone:row.customer.phone,
      udf1:row.accountId,udf2:row.packId,udf3:row.receipt,udf4:'',udf5:'',
      surl:this.config.publicUrl+'/api/payu/return',furl:this.config.publicUrl+'/api/payu/return'};
    fields.hash=paymentHash(fields,this.config.salt);
    const inputs=Object.entries(fields).map(([k,v])=>`<input type="hidden" name="${k}" value="${escape(v)}">`).join('');
    return page('Ready for PayU',`${this.config.mode==='test'?'<div class="mode">TEST MODE - no real money is charged</div>':''}<section class="summary"><div class="line"><span>${row.coins.toLocaleString('en-IN')} coins</span><strong>INR ${money(row.amountPaise)}</strong></div><p>Next, choose your payment method on PayU.</p></section><form method="post" action="${this.config.checkoutUrl}">${inputs}<button>Pay INR ${money(row.amountPaise)} with PayU</button></form><p>Return to the game after payment. A pending payment is not a completed purchase.</p>`);
  }
  async verifyPayment(id) {
    const fields={key:this.config.key,command:'verify_payment',var1:id,
      hash:sha512([this.config.key,'verify_payment',id,this.config.salt].join('|'))};
    try {
      const response=await this.fetch(this.config.verifyUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
        headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
      if (!response.ok) throw new Error('upstream');
      const body=await response.json();
      if (!object(body.transaction_details)||!object(body.transaction_details[id])) throw new Error('invalid response');
      return body.transaction_details[id];
    } catch(_) { fail(502,'gateway_unavailable','PayU verification is unavailable. Refresh later.'); }
  }
  async reconcile(row,paymentId) {
    if (row.status==='paid') return;
    this.requireEnabled();
    const value=await this.verifyPayment(row._id);
    if (value.status!=='success'||value.unmappedstatus!=='captured') return;
    const id=String(value.mihpayid||'');
    if (value.txnid!==row._id || toPaise(value.amt)!==row.amountPaise || value.udf1!==row.accountId
        ||value.udf2!==row.packId||value.udf3!==row.receipt||value.productinfo!==`${row.coins} game coins`
        ||row.currency!=='INR'||(value.currency&&value.currency!=='INR')||!/^\d{1,64}$/.test(id)
        ||(paymentId!==undefined&&id!==paymentId)||['refund','cancel'].includes(value.action)
        ||toPaise(value.amount_refunded??value.refund_amount??'0')!==0)
      fail(409,'payment_mismatch','Verified payment does not match this purchase.');
    await this.credit(row,id);
  }
  async credit(row,paymentId) {
    // Unique credit + balance + order state commit together. Atlas supports transactions.
    try {
      await this.connection.transaction(async session=>{
        const previous=await this.Credit.findOne({$or:[{_id:row._id},{paymentId}]}).session(session).lean();
        if (previous) {
          if (previous._id!==row._id||previous.paymentId!==paymentId) fail(409,'payment_reused','Payment already processed.');
          return;
        }
        await this.Credit.create([{_id:row._id,paymentId,accountId:row.accountId,coins:row.coins,created:this.now()}],{session});
        const updated=await this.Account.updateOne({_id:row.accountId,creditedCoinsTotal:{$lte:Number.MAX_SAFE_INTEGER-row.coins}},
          {$inc:{creditedCoinsTotal:row.coins}},{session});
        if (updated.modifiedCount!==1) fail(409,'wallet_unavailable','Wallet could not be updated.');
        await this.Order.updateOne({_id:row._id},{$set:{status:'paid',paymentId}},{session});
      });
    } catch(error) {
      if (error.code!==11000) throw error;
      const previous=await this.Credit.findOne({$or:[{_id:row._id},{paymentId}]}).lean();
      if (!previous||previous._id!==row._id||previous.paymentId!==paymentId)
        fail(409,'payment_reused','Payment already processed.');
    }
  }
  async getOrder(owner,id) {
    const row=await this.storedOrder(id,owner);
    await this.reconcile(row);
    return this.response(await this.storedOrder(id,owner));
  }
  async wallet(owner) {
    if (this.config.enabled) {
      const row=await this.Order.findOneAndUpdate({accountId:owner,status:'pending',lastChecked:{$lt:this.now()-10000}},
        {$set:{lastChecked:this.now()}},{sort:{lastChecked:1,created:1},new:true}).lean();
      if (row) try { await this.reconcile(row); } catch(error) {
        if (!(error instanceof PaymentError)) throw error;
        console.warn('PayU reconciliation deferred:',error.code);
      }
    }
    const account=await this.Account.findById(owner).lean();
    if (!account) fail(401,'unauthorized','Account not found.');
    return {accountId:owner,creditedCoinsTotal:account.creditedCoinsTotal};
  }
  async callback(fields) {
    this.requireEnabled();
    if (!object(fields)||Object.values(fields).some(v=>typeof v!=='string')||fields.key!==this.config.key
        ||fields.splitInfo||!/^[0-9a-fA-F]{128}$/.test(fields.hash||''))
      fail(400,'invalid_signature','PayU response could not be verified.');
    if (!crypto.timingSafeEqual(Buffer.from(responseHash(fields,this.config.salt),'hex'),Buffer.from(fields.hash,'hex')))
      fail(400,'invalid_signature','PayU response could not be verified.');
    const row=await this.storedOrder(fields.txnid);
    if (toPaise(fields.amount)!==row.amountPaise) fail(409,'payment_mismatch','Payment amount does not match.');
    await this.reconcile(row,fields.status==='success'?fields.mihpayid:undefined);
    return (await this.storedOrder(row._id)).status;
  }
}

function createPayments({connection,env=process.env,fetchImpl,now,authenticateGoogle}) {
  const config=configuration(env), service=new PayUService({connection,config,fetchImpl,now});
  const router=express.Router(), buckets=new Map();
  const limit=(key,max)=>{
    const time=Date.now(),old=buckets.get(key);
    if (buckets.size>10000) for (const [k,v] of buckets) if (time-v.start>60000) buckets.delete(k);
    const bucket=old&&time-old.start<60000?old:{start:time,count:0};
    if (++bucket.count>max) fail(429,'rate_limited','Please wait and try again.');
    buckets.set(key,bucket);
  };
  const paths=/^(?:\/payments\/health|\/api\/(?:accounts(?:\/link)?|catalog|wallet|orders(?:\/[^/]+)?|payu\/return|webhooks\/payu)|\/checkout\/[^/]+(?:\/pay)?)$/;
  router.use((req,res,next)=>{
    if (!paths.test(req.path)) return next('router');
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()'});
    next();
  });
  router.use(express.json({limit:'16kb'}),express.urlencoded({extended:false,limit:'64kb',parameterLimit:150}));
  const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  const identity=async req=>{if(!authenticateGoogle) fail(401,'google_login_required','Sign in with Google to purchase.');return authenticateGoogle(req.headers['x-game-session']);};
  const owner=async req=>{const user=await identity(req);const id=await service.authenticate(req.headers.authorization);await service.authorizeAccount(id,user.sub);limit('account:'+id,90);return id;};
  router.get('/payments/health',(_req,res)=>res.json({ok:true,provider:'payu',requiresGoogleLogin:true,testMode:config.mode==='test',paymentsEnabled:config.enabled}));
  router.get('/api/catalog',(_req,res)=>res.json(service.catalog()));
  router.post('/api/accounts',wrap(async(req,res)=>{
    const user=await identity(req);service.requireEnabled();limit('register:'+req.ip,10);
    if (!object(req.body)||Object.keys(req.body).length) fail(400,'invalid_account','Send an empty JSON object.');
    res.status(201).json(await service.createAccount(user.sub));
  }));
  router.post('/api/accounts/link',wrap(async(req,res)=>{const user=await identity(req);const id=await service.authenticate(req.headers.authorization);res.json(await service.linkAccount(id,user.sub));}));
  router.get('/api/wallet',wrap(async(req,res)=>res.json(await service.wallet(await owner(req)))));
  router.post('/api/orders',wrap(async(req,res)=>{
    const id=await owner(req);limit('orders:'+id,10);res.json(await service.createOrder(id,req.body));
  }));
  router.get('/api/orders/:id',wrap(async(req,res)=>res.json(await service.getOrder(await owner(req),req.params.id))));
  router.get('/checkout/:token',wrap(async(req,res)=>res.type('html').send(await service.checkoutHtml(req.params.token))));
  router.post('/checkout/:token/pay',wrap(async(req,res)=>{
    limit('checkout:'+digest(req.params.token),10);
    if (!req.is('application/x-www-form-urlencoded')) fail(415,'invalid_content_type','Submit the checkout form.');
    res.type('html').send(await service.startCheckout(req.params.token,req.body));
  }));
  for (const path of ['/api/payu/return','/api/webhooks/payu']) router.post(path,wrap(async(req,res)=>{
    if (!req.is('application/x-www-form-urlencoded')) fail(415,'invalid_content_type','Use a form-encoded PayU response.');
    limit('callback:'+digest(typeof req.body.txnid==='string'?req.body.txnid:''),30);
    const status=await service.callback(req.body);
    if (path.includes('webhooks')) return res.json({received:true});
    res.type('html').send(page(status==='paid'?'Payment confirmed':'Payment not yet confirmed',
      '<p>Return to the game and refresh your coin balance. If money was deducted, check the status before paying again.</p>'));
  }));
  router.use((error,req,res,_next)=>{
    const known=error instanceof PaymentError;
    const status=known?error.status:(['entity.too.large','parameters.too.many'].includes(error.type)?413:error.type==='entity.parse.failed'?400:500);
    const message=known?error.message:status===500?'Payment service unavailable. Please refresh later.':'Invalid request body.';
    if (status===500) console.error('PayU request failed:',error.name); // Never log payloads or URLs.
    if (req.path.startsWith('/checkout/')||req.path==='/api/payu/return')
      return res.status(status).type('html').send(page('Payment needs attention',`<p>${escape(message)}</p><p>Return to the game and refresh.</p>`));
    res.status(status).json({error:message,code:known?error.code:'payment_error'});
  });
  return {router,service,initialize:()=>service.initialize()};
}

module.exports={createPayments,PayUService,PaymentError,configuration,paymentHash,responseHash,toPaise,PACKS};
