schema.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this agent. Defaults to inherit.`)
export var KNOWN=["sonnet","opus","haiku","fable","opusplan"];
export function rz(x){switch(x){case"best":{return "opus"}default:return null}}
export function opts(e,t,r){let n=cur(),o=(n==="opus")?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}