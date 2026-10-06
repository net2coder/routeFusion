import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
loadEnv({path:resolve(root,'.env')});
const url=process.env.SUPABASE_URL;
const secret=process.env.SUPABASE_SECRET_KEY??process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerId=process.env.ROUTEFUSION_OWNER_ID;
if(!url||!secret||!ownerId)throw new Error('Set SUPABASE_URL, SUPABASE_SECRET_KEY, and ROUTEFUSION_OWNER_ID in .env first.');
const supabase=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
const config=JSON.parse(await readFile(resolve(root,'data/gateway-config.json'),'utf8')) as {providers:Array<Record<string,any>>;models:Array<Record<string,any>>};
const {error:configError}=await supabase.rpc('rf_replace_config',{p_owner_id:ownerId,p_providers:config.providers.map(p=>({id:p.id,name:p.name,base_url:p.baseUrl,api_key_env:p.apiKeyEnv??null,api_key_ciphertext:p.apiKeyCiphertext??null,key_hint:p.keyHint??null,priority:p.priority,timeout_ms:p.timeoutMs,enabled:p.enabled,status:'unknown',latency:null,cooldown_until:0,failures:0})),p_models:config.models.map(m=>({id:m.id,logical_model_id:m.logicalModelId,provider_id:m.providerId,provider_model_id:m.providerModelId,display_name:m.displayName,capabilities:m.capabilities,context_window:m.contextWindow,enabled:m.enabled,priority:m.priority}))});
if(configError)throw new Error(`Configuration import failed: ${configError.message}`);
let importedKeys=0;
try{const keys=JSON.parse(await readFile(resolve(root,'data/client-keys.json'),'utf8')) as Array<Record<string,any>>;const rows=keys.map(k=>({id:k.id,owner_id:ownerId,name:k.name,prefix:k.prefix,key_hash:k.hash,created_at:k.createdAt,last_used_at:k.lastUsedAt,revoked_at:k.revokedAt}));for(let i=0;i<rows.length;i+=500){const {error}=await supabase.from('rf_client_keys').upsert(rows.slice(i,i+500));if(error)throw error;}importedKeys=rows.length;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`Client key import failed: ${error instanceof Error?error.message:'unknown error'}`);}
let importedRequests=0;
try{const logs=JSON.parse(await readFile(resolve(root,'data/requests.json'),'utf8')) as Array<Record<string,any>>;const keyIds=new Set((JSON.parse(await readFile(resolve(root,'data/client-keys.json'),'utf8')) as Array<Record<string,any>>).map(k=>k.id));const rows=logs.slice(0,10000).map(r=>({id:r.id,owner_id:ownerId,api_key_id:keyIds.has(r.apiKeyId)?r.apiKeyId:null,api_key_name:r.apiKeyName??'Unknown',time:r.time,virtual_model:r.virtualModel,provider:r.provider,actual_model:r.actualModel,latency:r.latency,tokens:r.tokens,status:r.status,attempts:r.attempts}));for(let i=0;i<rows.length;i+=500){const {error}=await supabase.from('rf_request_logs').upsert(rows.slice(i,i+500));if(error)throw error;}importedRequests=rows.length;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error(`Request history import failed: ${error instanceof Error?error.message:'unknown error'}`);}
process.stdout.write(`Imported ${config.providers.length} providers, ${config.models.length} models, ${importedKeys} client keys, and ${importedRequests} request records.\n`);
