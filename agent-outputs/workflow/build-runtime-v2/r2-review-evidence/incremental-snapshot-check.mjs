import {execFileSync} from 'node:child_process';import fs from 'node:fs';import crypto from 'node:crypto';
const cwd='/Users/run.mao/workpace/feishu-sync',env={...process.env,GIT_INDEX_FILE:'/tmp/feishu-build-v2-r3/feature.index'};
const git=(a)=>execFileSync('git',a,{cwd,env,encoding:'utf8'});
const paths=git(['diff','--cached','--name-only','HEAD']).trim().split('\n');let mismatches=[];
for(const p of paths){const expected=git(['rev-parse',`:${p}`]).trim();const content=fs.readFileSync('/tmp/feishu-build-v2-r3/feature-final/'+p);const actual=crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');if(expected!==actual)mismatches.push({p,expected,actual});}
console.log(JSON.stringify({paths:paths.length,mismatches},null,2));if(mismatches.length)process.exitCode=1;
