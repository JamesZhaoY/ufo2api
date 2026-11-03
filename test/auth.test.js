'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ufo-auth-'));process.env.UFO_HOME=tmp;delete process.env.UFO_PROXY_API_KEY;const auth=require('../auth');
test('generates a stable private key and rotates it',()=>{let a=auth.key();assert.match(a,/^sk-ufo-/);assert.equal(auth.key(),a);assert.equal(fs.statSync(path.join(tmp,'api-key')).mode&0o777,0o600);assert.throws(()=>auth.set('invalid key'));auth.set('custom-key');assert.equal(auth.key(),'custom-key');});
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
