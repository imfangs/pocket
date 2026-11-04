import { mkdirSync, openSync, writeFileSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
export function acquireDataLock(directory) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const path=join(directory,'.pocket-service.lock');
  const token=randomBytes(16).toString('hex');
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const fd=openSync(path,'wx',0o600);
      try { writeFileSync(fd,JSON.stringify({kind:'pocket-service-v1',pid:process.pid,token})); } finally { closeSync(fd); }
      return ()=>{try{if(JSON.parse(readFileSync(path,'utf8')).token===token)unlinkSync(path);}catch{}};
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      // Never reap automatically: a stat/unlink check is not compare-and-swap.
      // Explicit recovery happens only after the owner stops all writers.
      throw new Error('Another Pocket instance or a stale lock is using this data directory. Stop all instances before manual lock recovery.');
    }
  }
  throw new Error('Could not acquire Pocket data lock');
}
