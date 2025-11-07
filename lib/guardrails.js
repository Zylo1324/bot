export const limitWords=(txt,max=30)=>txt.trim().split(/\s+/).slice(0,max).join(" ");
export const verticalize=(txt,max=3)=>txt.replace(/\s*[,;]\s*/g,"\n")
  .split("\n").map(x=>x.trim()).filter(Boolean).slice(0,max).join("\n");