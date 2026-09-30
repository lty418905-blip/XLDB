import type {ProfileBasis,ProfileCategory,ProfileExport,ProfileTheme} from './types.ts';

/** Readable labels for the user-facing export; category and theme codes never appear in the Markdown. */
const categoryLabels:Record<ProfileCategory,string>={experience:'经历',current_context:'近况',schedule:'日程安排',habit:'习惯',
  observation:'观察',preference:'偏好',hypothesis:'猜测'};
const themeLabels:Record<ProfileTheme,string>={life_background:'生活背景',daily_routine:'日常作息',communication:'沟通方式',
  support:'需要的支持',goals:'目标',other:'其它'};
const themeOrder:ProfileTheme[]=['life_background','daily_routine','communication','support','goals','other'];
const kindLabels:Record<ProfileBasis,string>={explicit:'你明确说过',observed:'她观察到的',inferred:'她的推测',planned:'你提过的打算'};

/**
 * Markdown rendering of a profile export, grouped by theme. Each entry shows its claim, readable kind, status, first
 * seen and last confirmed dates in the export's zone, and the user's own quotes. No numbers besides dates.
 */
export function profileExportMarkdown(value:ProfileExport):string {
  const date=dateFormat(value.timeZone);
  const lines=['# 她以为的你','',`导出时间：${date(value.exportedAtMs,true)}（${value.timeZone}）`,''];
  if(!value.entries.length)lines.push('她还没有记下关于你的内容。','');
  for(const theme of themeOrder){
    const entries=value.entries.filter(entry=>entry.theme===theme);
    if(!entries.length)continue;
    lines.push(`## ${themeLabels[theme]}`,'');
    for(const entry of entries){
      lines.push(`- ${oneLine(entry.claim)}`);
      const facts=[`类别：${categoryLabels[entry.category]}`,`依据：${entry.corrected?'你亲自纠正过':kindLabels[entry.kind]}`,
        `状态：${entry.status==='active'?'在用':'未采用'}`];
      if(entry.firstSeenAtMs!==null)facts.push(`首次出现：${date(entry.firstSeenAtMs)}`);
      if(entry.lastConfirmedAtMs!==null)facts.push(`最近印证：${date(entry.lastConfirmedAtMs)}`);
      lines.push(`  - ${facts.join('；')}`);
      const supports=entry.quotes.filter(quote=>quote.polarity==='support'),counters=entry.quotes.filter(quote=>quote.polarity==='counter');
      if(supports.length){
        lines.push('  - 你的原话：');
        for(const quote of supports)lines.push(`    - 「${oneLine(quote.text)}」（${date(quote.acceptedAtMs)}）`);
      }
      if(counters.length){
        lines.push('  - 与之相反的原话：');
        for(const quote of counters)lines.push(`    - 「${oneLine(quote.text)}」（${date(quote.acceptedAtMs)}）`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function dateFormat(timeZone:string):(ms:number,withTime?:boolean)=>string {
  const day=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  return (ms,withTime=false)=>withTime?`${day.format(ms)} ${clock.format(ms)}`:day.format(ms);
}
function oneLine(value:string):string {return value.replace(/\s+/gu,' ').trim();}
