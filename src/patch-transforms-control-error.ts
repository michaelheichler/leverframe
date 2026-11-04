export const ROUTING_CONTROL_ERROR_READER = 'async function __lfControlError(r){let text="",size=0;try{let reader=r.body?.getReader(),decoder=new TextDecoder();'
  + 'if(reader){for(;;){let p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>4096){await reader.cancel();text="";break}'
  + 'text+=decoder.decode(p.value,{stream:true})}text+=decoder.decode()}}catch{}let e;try{e=JSON.parse(text)?.error}catch{}'
  + 'let code=typeof e?.code==="string"&&/^[a-z0-9_]{1,80}$/.test(e.code)?e.code:void 0;'
  + 'let message=typeof e?.message==="string"?e.message.replace(/[\\x00-\\x1f\\x7f]/g," ").slice(0,256):void 0;'
  + 'return [code,message].filter(Boolean).join(": ")}';
