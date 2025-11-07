const KEYS=["chatgpt","sora","perplexity","gemini","veo","turnitin","vip",
"canva","capcut","disney","hbo","prime","youtube","directv","luna","scribd"];
export const detectService=t=>KEYS.find(k=>(t||"").toLowerCase().includes(k))||null;
export const wantsCatalog=t=>{
  const s=(t||"").toLowerCase();
  return /(servicio|servicios|planes|opciones|que ofrecen|qué ofrecen)/.test(s) && !detectService(s);
};