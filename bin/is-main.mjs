import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function isMain(url,argument=process.argv[1]) {
  if(!argument)return false;
  try{return realpathSync(argument)===realpathSync(fileURLToPath(url));}catch{return false;}
}
