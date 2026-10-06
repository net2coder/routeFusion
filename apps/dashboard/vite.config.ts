import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const envDir=fileURLToPath(new URL('../..',import.meta.url));
export default defineConfig(({command,mode})=>{
  const env=loadEnv(mode,envDir,'');
  return {plugins:[react()],envDir,server:{port:5173,...(command==='serve'?{proxy:{'/admin':{target:'http://localhost:3000',changeOrigin:true,configure(proxy){proxy.on('proxyReq',proxyReq=>{if(env.ADMIN_SECRET)proxyReq.setHeader('Authorization',`Bearer ${env.ADMIN_SECRET}`);});}}}}:{})}};
});
