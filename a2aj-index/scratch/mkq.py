import json
SB=r"C:/Users/elias/AppData/Local/Temp/claude/C--Users-elias-Desktop-MikeOSS-Fork/1f20d775-c0b0-4f05-b9bf-1a656c0b4e6c/scratchpad/search-bench"
qs=json.load(open(SB+"/queries.json",encoding="utf-8")); tg=json.load(open(SB+"/data/targets.json"))
tabs=json.load(open(SB+"/data/tabs-passages.json",encoding="utf-8")); extra=json.load(open(SB+"/data/extra-passages.json",encoding="utf-8"))
out=[]
for q in qs:
    if q["type"]=="para":
        pool,i=q["target"].split(":"); p=(tabs if pool=="tabs" else extra)[int(i)]
        assert int(p["doc"])==tg[q["id"]]
        out.append({"id":q["id"],"set":"bench","type":"nl","query":q["query"],"docs":[f"c:{tg[q['id']]}"],"passage":{"doc":int(p["doc"]),"start":int(p["start"]),"len":len(p["text"])}})
    else:
        out.append({"id":q["id"],"set":"bench","type":"phrase","query":'"'+q["query"]+'"'})
K=[("Jordan delay ceiling","c:193532"),("test for summary judgment Ontario","c:193318"),("duty to consult Crown honour","c:190422"),
("duty of honest contractual performance","c:192449"),("Gladue principles sentencing Indigenous offenders","c:188060 c:193496"),("Oakes test minimal impairment","c:192782"),
("W.(D.) credibility reasonable doubt","c:196601"),("Canada Evidence Act business records","l:1269"),("Aboriginal title Tsilhqot'in","c:192659"),
("Charter damages Ward","c:196030"),("Browne v. Dunn cross-examination",""),("Bardal factors reasonable notice",""),("oppression remedy reasonable expectations","c:195590"),
("joint family venture unjust enrichment","c:196086"),("abuse of process residual category stay","c:193201")]
N=[("reasonableness standard of review for administrative decisions","c:193739"),("exclusion of evidence under section 24(2) and the factors to weigh","c:196218"),
("standard of review for contractual interpretation as a question of mixed fact and law","c:192438"),("procedural fairness factors and legitimate expectations in immigration decisions","c:193472"),
("test for an interlocutory injunction: serious issue, irreparable harm and balance of convenience","c:192965"),("psychological injury is too remote unless a person of ordinary fortitude would suffer it","c:197538"),
("when material contribution to risk replaces the but for test of causation","c:188737"),("appellate courts defer to trial judges unless there is a palpable and overriding error","c:190131"),
("is a library photocopy service fair dealing for research","c:190732"),("criminal prohibition on physician assisted dying violates section 7","c:192536"),
("adverse impact discrimination against women who job-shared and lost pension credit","c:193828"),("punitive damages for bad faith in the manner of dismissal","c:197481"),
("enforcing a foreign judgment against a subsidiary does not require a real and substantial connection","c:194503"),("does a person have a reasonable expectation of privacy in IP address subscriber information","c:192662"),
("sender's reasonable expectation of privacy in text messages on the recipient's phone","c:193499"),("admitting hearsay under the principled approach based on necessity and reliability","c:189660"),
("humanitarian and compassionate relief should not be limited to unusual and undeserved hardship","c:194466"),("honour of the Crown requires diligent implementation of constitutional promises to the Métis","c:193277"),
("early dismissal of strategic lawsuits that limit expression on matters of public interest","c:193718"),("whether a regulator owes a private law duty of care to investors: proximity under Anns","c:190280"),
("right to consult counsel again during a custodial interrogation","c:196039"),("police must inform a detained person of the right to counsel immediately","c:196221"),
("appellate deference to sentences that depart from a sentencing range","c:194462"),("law society refusing to accredit a law school with a mandatory covenant against same-sex intimacy","c:193476"),
("enforceability of an exclusion clause after a fundamental breach","c:196200"),("employer vicariously liable for sexual abuse by an employee of a non-profit","c:193453"),
("limitation period starts when the claim is discovered, two years Ontario","l:4226"),("impaired driving blood alcohol over 80 offence","l:1258"),
("inadmissibility on grounds of serious criminality for permanent residents","l:1506")]
Ph=[('"honour of the Crown"',""),('"reasonable expectation of privacy" text messages recipient',"c:193499"),('"genuine issue requiring a trial" proportionate',"c:193318"),
('"palpable and overriding error"',""),('"Jordan ceiling"',"")]
i=0
for typ,lst in (("keyword",K),("nl",N),("phrase",Ph)):
    for q,t in lst:
        i+=1; e={"id":f"L{i:02d}","set":"legal","type":typ,"query":q}
        if t: e["docs"]=t.split()
        out.append(e)
json.dump(out,open("bench/queries.json","w",encoding="utf-8"),indent=0,ensure_ascii=False)
from collections import Counter
print(len(out),Counter((q["set"],q["type"],"docs" in q) for q in out))
