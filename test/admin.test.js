const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdminMiddleware } = require('../src/middleware/admin');
test('administrator access uses current database role, fails closed, and ignores stale claims', async () => {
  let role = true, advanced = 0, status;
  const req = {user:{userId:7,isAdmin:false}};
  const res = {status(code){status=code;return this;},json(){return this;}};
  const admin = createAdminMiddleware({user:{findUnique:async({where})=>{assert.equal(where.id,7);return role===null?null:{isAdmin:role};}}});
  await admin(req,res,()=>advanced++);
  assert.equal(advanced,1);
  role=false; req.user.isAdmin=true;
  await admin(req,res,()=>advanced++);
  assert.equal(status,403);assert.equal(advanced,1);
  role=null;await admin(req,res,()=>advanced++);assert.equal(status,403);assert.equal(advanced,1);
  let error;
  const offline=createAdminMiddleware({user:{findUnique:async()=>{throw new Error('offline');}}});
  await offline(req,res,e=>{error=e;});assert.equal(error.message,'offline');
});
