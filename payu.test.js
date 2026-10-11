const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');
const mongoose=require('mongoose');
const express=require('express');
const {once}=require('node:events');
const {PayUService,createPayments,configuration,paymentHash,responseHash,toPaise}=require('./payu');

let mongo,folder,connection,uri,service,account,order,row,remote,clock,config;
const env={PAYU_KEY:'fixture-key',PAYU_SALT:'fixture-salt',PUBLIC_URL:'https://payments.example',
  PAYMENTS_ENABLED:'true',PAYMENT_MODE:'test'};
const customer={firstname:'Test <User>',email:'test@example.com',phone:'9999999999'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort() {
  const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
before(async()=>{
  folder=fs.mkdtempSync(path.join(os.tmpdir(),'monster-payu-mongo-'));
  const port=await freePort();
  mongo=spawn(process.env.MONGOD_BINARY||'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe',
    ['--dbpath',folder,'--port',String(port),'--bind_ip','127.0.0.1','--replSet','payuTest','--logpath',path.join(folder,'mongo.log')],{windowsHide:true,stdio:'ignore'});
  let startupError;
  mongo.on('error',error=>{startupError=error;});
  const direct=mongoose.createConnection(`mongodb://127.0.0.1:${port}/admin?directConnection=true`,{serverSelectionTimeoutMS:20000});
  await direct.asPromise();
  if(startupError)throw startupError;
  await direct.db.admin().command({replSetInitiate:{_id:'payuTest',members:[{_id:0,host:`127.0.0.1:${port}`}]}});
  await direct.close();
  uri=`mongodb://127.0.0.1:${port}/payu_integration?replicaSet=payuTest`;
  connection=await mongoose.createConnection(uri,{serverSelectionTimeoutMS:20000}).asPromise();
  config=configuration(env);
  const instance=new PayUService({connection,config});await instance.initialize();
});
after(async()=>{
  if(connection)await connection.close();
  if(mongo&&mongo.exitCode===null){const done=once(mongo,'exit');mongo.kill();await done;}
  if(folder)fs.rmSync(folder,{recursive:true,force:true}); // Only our unique temporary database.
});
beforeEach(async()=>{
  clock=1900000000000;remote=new Map();
  service=new PayUService({connection,config,now:()=>clock,fetchImpl:async(url,request)=>{
    assert.equal(url,'https://test.payu.in/merchant/postservice.php?form=2');
    const fields=new URLSearchParams(request.body),id=fields.get('var1');
    assert.equal(fields.get('command'),'verify_payment');
    assert.equal(fields.get('hash'),crypto.createHash('sha512').update(`fixture-key|verify_payment|${id}|fixture-salt`).digest('hex'));
    assert.equal(request.redirect,'error');
    return {ok:true,json:async()=>({transaction_details:{[id]:remote.get(id)||{status:'Not Found'}}})};
  }});
  await Promise.all([service.Account.deleteMany({}),service.Order.deleteMany({}),service.Credit.deleteMany({})]);
  account=await service.createAccount();order=await service.createOrder(account.accountId,{packId:'starter',requestId:'test_request_001'});
  row=await service.storedOrder(order.orderId);
});
function capture(changes={},target=row) {
  const data={txnid:target._id,mihpayid:'123456789',amt:'49.00',status:'success',unmappedstatus:'captured',
    udf1:target.accountId,udf2:target.packId,udf3:target.receipt,productinfo:`${target.coins} game coins`,...changes};
  remote.set(target._id,data);return data;
}
function callback(changes={}) {
  const fields={key:'fixture-key',txnid:row._id,amount:'49.00',status:'success',mihpayid:'123456789',
    firstname:customer.firstname,email:customer.email,productinfo:'500 game coins',udf1:row.accountId,
    udf2:row.packId,udf3:row.receipt,...changes};
  fields.hash=responseHash(fields,'fixture-salt');return fields;
}
const rejects=(fn,code)=>assert.rejects(fn,error=>error.code===code);

test('independent PayU request and reverse hash vectors',()=>{
  const fields={key:'key',txnid:'txn',amount:'49.00',productinfo:'coins',firstname:'Name',email:'a@b.c',udf1:'owner',udf2:'pack'};
  const hash=s=>crypto.createHash('sha512').update(s).digest('hex');
  assert.equal(paymentHash(fields,'salt'),hash('key|txn|49.00|coins|Name|a@b.c|owner|pack|||||||||salt'));
  fields.status='success';
  assert.equal(responseHash(fields,'salt'),hash('salt|success|||||||||pack|owner|a@b.c|Name|coins|49.00|txn|key'));
  fields.additionalCharges='1.00';
  assert.equal(responseHash(fields,'salt'),hash('1.00|salt|success|||||||||pack|owner|a@b.c|Name|coins|49.00|txn|key'));
});
test('strict INR amount parsing and configuration guards',()=>{
  for(const amount of ['NaN','Infinity','-1','0.001','1e2',null])assert.throws(()=>toPaise(amount));
  assert.equal(toPaise('49.00'),4900);
  assert.equal(configuration({}).enabled,false);
  assert.throws(()=>configuration({...env,PAYMENT_MODE:'live'}));
  assert.throws(()=>configuration({...env,PUBLIC_URL:'http://unsafe.example'}));
  assert.throws(()=>configuration({...env,PUBLIC_URL:'https://safe.example/path'}));
  assert.equal(configuration({...env,PAYMENT_MODE:'live',ALLOW_LIVE_PAYMENTS:'true'}).checkoutUrl,'https://secure.payu.in/_payment');
});
test('price authority, unknown packs and conflicting idempotency keys',async()=>{
  await rejects(()=>service.createOrder(account.accountId,{packId:'starter',requestId:'another_001',amount:1}),'invalid_order');
  await rejects(()=>service.createOrder(account.accountId,{packId:'bad',requestId:'another_001'}),'invalid_order');
  await rejects(()=>service.createOrder(account.accountId,{packId:'legend',requestId:'test_request_001'}),'request_conflict');
  const again=await service.createOrder(account.accountId,{packId:'starter',requestId:'test_request_001'});
  assert.deepEqual(again,order);assert.equal(order.amountPaise,4900);
});
test('concurrent order creation produces one stored checkout',async()=>{
  const results=await Promise.all(Array.from({length:12},()=>service.createOrder(account.accountId,{packId:'legend',requestId:'concurrent_order'})));
  assert.equal(new Set(results.map(r=>r.orderId)).size,1);
  assert.equal(await service.Order.countDocuments({requestId:'concurrent_order'}),1);
});
test('bearer tokens are hashed and another account cannot query an order',async()=>{
  const stored=await service.Account.findById(account.accountId).lean();
  assert.notEqual(stored.tokenHash,account.token);assert.equal(stored.token,undefined);
  assert.equal(await service.authenticate('Bearer '+account.token),account.accountId);
  await rejects(()=>service.authenticate('Bearer bad'),'unauthorized');
  const other=await service.createAccount();
  await rejects(()=>service.getOrder(other.accountId,order.orderId),'order_not_found');
});
test('contact validation, HTML escaping and no salt or bearer in checkout',async()=>{
  await rejects(()=>service.startCheckout(row.checkoutToken,{...customer,firstname:'bad|hash'}),'invalid_customer');
  const html=await service.startCheckout(row.checkoutToken,customer);
  assert.match(html,/Test &lt;User&gt;/);assert.match(html,/https:\/\/test.payu.in\/_payment/);
  assert.ok(!html.includes('fixture-salt'));assert.ok(!html.includes(account.token));
  const retried=await service.startCheckout(row.checkoutToken,{...customer,firstname:'Changed'});
  assert.ok(!retried.includes('Changed'));
});
test('fake success callback and authorized-only payment never add coins',async()=>{
  assert.equal(await service.callback(callback()),'pending');
  for(const status of ['pending','auth','failed','refunded']){capture({unmappedstatus:status});await service.reconcile(row);}
  assert.equal(await service.Credit.countDocuments({}),0);
});
test('invalid signatures and duplicate callback fields are rejected',async()=>{
  capture();
  await rejects(()=>service.callback({...callback(),hash:'0'.repeat(128)}),'invalid_signature');
  await rejects(()=>service.callback({...callback(),txnid:[row._id,'another']}),'invalid_signature');
  await rejects(()=>service.callback(callback({key:'other'})),'invalid_signature');
  assert.equal(await service.Credit.countDocuments({}),0);
});
test('verified amount, transaction, ownership, currency and refund checks',async()=>{
  for(const changes of [{amt:'0.49'},{txnid:'other'},{udf1:'other'},{udf2:'other'},{udf3:'other'},
    {productinfo:'other'},{currency:'USD'},{refund_amount:'49.00'},{action:'refund'},{mihpayid:''}]){
    capture(changes);await rejects(()=>service.reconcile(row),'payment_mismatch');
  }
  assert.equal(await service.Credit.countDocuments({}),0);
});
test('concurrent callback and wallet reconciliation credit exactly once',async()=>{
  capture();
  await Promise.all(Array.from({length:16},(_,i)=>i%2?service.callback(callback()):service.wallet(account.accountId)));
  assert.equal((await service.wallet(account.accountId)).creditedCoinsTotal,500);
  assert.equal(await service.Credit.countDocuments({}),1);
  assert.equal((await service.storedOrder(row._id)).status,'paid');
});
test('Mongo transaction rolls back credit and balance when order update fails',async()=>{
  capture();
  const update=service.Order.updateOne;
  service.Order.updateOne=()=>{throw new Error('Injected order update failure');};
  try{await assert.rejects(()=>service.reconcile(row),/Injected order update failure/);}finally{service.Order.updateOne=update;}
  assert.equal(await service.Credit.countDocuments({}),0);
  assert.equal((await service.Account.findById(account.accountId).lean()).creditedCoinsTotal,0);
  assert.equal((await service.storedOrder(row._id)).status,'pending');
  await service.reconcile(row);
  assert.equal((await service.wallet(account.accountId)).creditedCoinsTotal,500);
});
test('payment ID cannot credit two orders',async()=>{
  capture();await service.reconcile(row);
  const other=await service.createOrder(account.accountId,{packId:'starter',requestId:'other_order_001'});
  const otherRow=await service.storedOrder(other.orderId);capture({},otherRow);
  await rejects(()=>service.reconcile(otherRow),'payment_reused');
  assert.equal((await service.Account.findById(account.accountId).lean()).creditedCoinsTotal,500);
});
test('payment ID from callback must match verified provider response',async()=>{
  capture();await rejects(()=>service.callback(callback({mihpayid:'987654321'})),'payment_mismatch');
});
test('lost callback recovers even after checkout expires',async()=>{
  clock+=1800001;await rejects(()=>service.checkoutOrder(row.checkoutToken),'checkout_expired');
  capture();assert.equal((await service.wallet(account.accountId)).creditedCoinsTotal,500);
});
test('outage leaves pending order recoverable and does not expose upstream secrets',async()=>{
  const original=service.fetch;service.fetch=async()=>{throw new Error('secret upstream details');};
  assert.equal((await service.wallet(account.accountId)).creditedCoinsTotal,0);
  await rejects(()=>service.callback(callback()),'gateway_unavailable');
  service.fetch=original;clock+=10001;capture();
  assert.equal((await service.wallet(account.accountId)).creditedCoinsTotal,500);
});
test('restarting database connection preserves credits and test/live isolation',async()=>{
  capture();await service.reconcile(row);
  const next=await mongoose.createConnection(uri).asPromise();
  try{
    const restarted=new PayUService({connection:next,config,fetchImpl:service.fetch});await restarted.initialize();
    assert.equal((await restarted.wallet(account.accountId)).creditedCoinsTotal,500);
    const live=new PayUService({connection:next,config:configuration({...env,PAYMENT_MODE:'live',ALLOW_LIVE_PAYMENTS:'true'})});
    await live.initialize();await rejects(()=>live.authenticate('Bearer '+account.token),'unauthorized');
  }finally{await next.close();}
});
test('HTTP app contract, form callbacks, webhook replay and unrelated routes',async()=>{
  const app=express(),payments=createPayments({connection,env,fetchImpl:service.fetch,now:()=>clock});
  app.use(payments.router);app.get('/health',(_req,res)=>res.json({ok:true,apps:['balloonpop','candycraze']}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  try{
    const health=await (await fetch(base+'/health')).json();assert.deepEqual(health.apps,['balloonpop','candycraze']);
    const catalog=await (await fetch(base+'/api/catalog')).json();assert.equal(catalog.provider,'payu');assert.equal(catalog.testMode,true);
    let response=await fetch(base+'/api/orders/'+order.orderId);assert.equal(response.status,401);
    response=await fetch(base+'/checkout/'+row.checkoutToken);assert.equal(response.headers.get('cache-control'),'no-store');assert.match(await response.text(),/500 game coins/);
    capture();
    for(const path of ['/api/payu/return','/api/webhooks/payu','/api/webhooks/payu']){
      response=await fetch(base+path,{method:'POST',body:new URLSearchParams(callback())});assert.equal(response.status,200);
    }
    assert.equal((await service.wallet(account.accountId)).creditedCoinsTotal,500);
    response=await fetch(base+'/api/webhooks/payu',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(callback()).toString()+'&txnid=other'});
    assert.equal(response.status,400);
    response=await fetch(base+'/api/webhooks/payu',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(callback())});assert.equal(response.status,415);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('actual auth server boots with payments disabled and preserves Google routes',async()=>{
  const port=await freePort();
  const child=spawn(process.execPath,[path.join(__dirname,'server.js')],{cwd:__dirname,windowsHide:true,stdio:'ignore',
    env:{...process.env,MONGODB_URI:uri,PORT:String(port),PUBLIC_URL:'https://payments.example',
      GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'fixture-google-secret',
      JWT_SECRET:'test-fixture-jwt-secret-longer-than-32-characters',PAYMENTS_ENABLED:'false',PAYMENT_MODE:'test',PAYU_KEY:'',PAYU_SALT:''}});
  try{
    let healthy=false;
    for(let i=0;i<80;i++){
      if(child.exitCode!==null)throw new Error('Auth server exited before readiness');
      try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){healthy=true;break;}}catch(_){}
      await pause(100);
    }
    assert.equal(healthy,true);
    const base=`http://127.0.0.1:${port}`;
    assert.deepEqual((await (await fetch(base+'/health')).json()).apps,['balloonpop','candycraze']);
    assert.equal((await (await fetch(base+'/payments/health')).json()).paymentsEnabled,false);
    assert.equal((await fetch(base+'/auth/google?app=unknown')).status,400);
    assert.equal((await fetch(base+'/api/me')).status,401);
    assert.equal((await fetch(base+'/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,503);
  }finally{if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
});
