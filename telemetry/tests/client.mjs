// Browser APIs simulated deterministically; no browser, network or GPU required.
import vm from 'node:vm'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
const source = fs.readFileSync(new URL('../../src/telemetry.js', import.meta.url), 'utf8')
assert(!/\buseFrame\s*\(|\brequestAnimationFrame\s*\(/.test(source), 'No frame work')
const script = source.replace("import { useEffect } from 'react'", 'const useEffect = () => {}').replace("import { gfxReport } from './gfx-report.js'", '').replaceAll('export function ', 'function ').replace('import.meta.env.DEV', 'DEV')
function fixture({dev=false,host='example.com',blocked=false,fail=false,dnt=null}={}) {
  let now=0, next=0, frameCalls=0
  const tasks=new Map(), requests=[], saved=new Map(), handlers={}
  const document={visibilityState:'visible',referrer:'https://mail.google.com/private?q=secret', addEventListener:(n,fn)=>handlers[n]=fn}
  const navigator={doNotTrack:dnt,sendBeacon:(url,blob)=>{requests.push({type:'beacon',body:JSON.parse(blob.body)});return true}}
  const ctx=vm.createContext({DEV:dev,location:{hostname:host,search:'?src=test&utm_source=resume'}, document,navigator,screen:{width:900,height:600},URL,URLSearchParams,AbortSignal,
    gfxReport:()=>({gpu:'Test GPU',frames:10,triangles:20,shaderErrors:[],lost:0}),
    crypto:{randomUUID:()=> 'b3867ed5-e788-4ea3-986c-76c86f6c5d4b'},performance:{now:()=>now},
    Blob:class{constructor(parts){this.body=parts.join('')}},
    sessionStorage:{getItem:k=>{if(blocked)throw Error();return saved.get(k)},setItem:(k,v)=>{if(blocked)throw Error();saved.set(k,v)}},
    setTimeout:fn=>{tasks.set(++next,fn);return next},clearTimeout:id=>tasks.delete(id),
    setInterval:fn=>{tasks.set(++next,fn);return next},clearInterval:id=>tasks.delete(id),
    fetch:(url,opts)=>{requests.push({type:'fetch',body:JSON.parse(opts.body)});return fail?Promise.reject(Error('offline')):Promise.resolve({ok:true})},
    requestAnimationFrame:()=>{frameCalls++},console,
  })
  ctx.window={addEventListener:(n,fn)=>handlers[n]=fn}
  vm.runInContext(script,ctx)
  return {ctx,requests,tasks,handlers,saved,document,setTime:n=>now=n,frames:()=>frameCalls}
}
for(const options of [{dev:true},{host:'localhost'},{host:'127.0.0.1'},{dnt:'1'}]) {
  const f=fixture(options);vm.runInContext("track('case_pulled')",f.ctx)
  assert.equal(f.tasks.size,0);assert.equal(f.requests.length,0)
}
const f=fixture({blocked:true})
f.setTime(2000);vm.runInContext('flush()',f.ctx)
assert.equal(f.requests[0].body.visible_ms,2000)
assert.equal(f.requests[0].body.referrer,'https://mail.google.com')
assert.equal(f.requests[0].body.utm_source,'resume')
f.setTime(5000);f.document.visibilityState='hidden';f.handlers.visibilitychange()
assert.equal(f.requests.at(-1).body.visible_ms,5000)
f.setTime(65000);f.document.visibilityState='visible';f.handlers.visibilitychange()
f.setTime(68000);f.handlers.pagehide()
assert.equal(f.requests.at(-1).body.visible_ms,8000,'60 seconds hidden must not count')
assert.equal(f.requests.at(-1).type,'beacon')
assert.equal(f.frames(),0)
vm.runInContext("for(let i=0;i<10000;i++)track('page_viewed',{page:i})",f.ctx)
vm.runInContext('flush()',f.ctx)
assert.equal(f.requests.at(-1).body.events.length,40,'queue is bounded')
const failed=fixture({fail:true})
vm.runInContext('flush()',failed.ctx)
await new Promise(resolve=>setImmediate(resolve))
vm.runInContext("track('contact_opened');flush()",failed.ctx)
assert.equal(failed.requests.length,1,'no retries after failure')
assert.equal(failed.tasks.size,0,'timers stop on failure')
const bench=fixture()
const start=performance.now()
vm.runInContext("for(let i=0;i<100000;i++)track('page_viewed',{page:i})",bench.ctx)
const us=(performance.now()-start)*1000/100000
console.log(`Client tests PASS: dev/localhost/DNT no-op; blocked storage; visible-only dwell; final sendBeacon; bounded queue; failure circuit-breaker; zero frame callbacks. Bounded track cost ${us.toFixed(3)} microseconds/call (synthetic full-queue benchmark, not FPS).`)

const gfx=fixture(); const listeners={}; let shaderCalls=0
const gl={domElement:{addEventListener:(event,fn)=>listeners[event]=fn},debug:{onShaderError:()=>{shaderCalls++}}}
gfx.ctx.gl=gl
vm.runInContext('watchGraphics(gl)',gfx.ctx)
// Baseline timer is the last scheduled task; it emits only once.
const baseline = [...gfx.tasks.values()].at(-1); baseline(); baseline()
listeners.webglcontextlost(); listeners.webglcontextlost()
gl.debug.onShaderError(); gl.debug.onShaderError()
vm.runInContext('flush()',gfx.ctx)
assert.equal(gfx.requests.at(-1).body.events.filter(e=>e.event==='gfx').length,3)
assert.equal(shaderCalls,2,'original diagnostics still run')
assert.equal(gfx.frames(),0)
console.log('Graphics client PASS: baseline/lost/shader exactly once each; original shader handler preserved; zero frame callbacks.')
