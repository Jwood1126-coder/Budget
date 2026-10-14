# Frontier AI Model Capability Trajectory, Late 2026 to 2031 (the engine under Microsoft Copilot)

Research date: 2026-10-14. Labels used throughout: **[MEASURED]** = published evaluation data; **[EXTRAPOLATION]** = trend projection (mine or a cited source's); **[OPINION/FORECAST]** = stated belief of a person/org; **[LAB CLAIM]** = self-reported by the company with limited outside verification; **[TRAINING-KNOWLEDGE]** = fact recalled from pre-2026 sources and not re-fetched in this session (the URL is the known primary source; verify before quoting).

Access note: several primary sites (metr.org, blog.aifutures.org, thenextweb.com, agitracker.io) failed DNS resolution from the research sandbox, so some 2026 figures come from search-engine extracts of those pages and from secondary trackers. These are flagged.

---

## 1. METR task-horizon measurements, 2026 data points, and extrapolation to 2027-2031

### Takeaway
METR's "time horizon" (length of human-expert software/research task an AI completes at a given success rate) has been doubling roughly every 4-4.5 months since 2023 (vs. ~7 months over 2019-2025). The frontier hit ~16+ hours at 50% reliability by early 2026 (Claude Mythos Preview), but only ~3 hours at 80% reliability, and METR says its task suite is saturating above ~16 hours. Projecting forward, the base case puts the 50% horizon at multiple work-weeks by 2027 and multiple work-months by 2028. The 80% horizon, which matters more for unsupervised enterprise work, trails by about 5x.

### Cited Findings
**Method and trend rates**
- [MEASURED] The original METR paper (March 2025) found that the 50% time horizon doubled about every 7 months from 2019 to 2025 and may have sped up in 2024 — [Measuring AI Ability to Complete Long Software Tasks, arXiv 2503.14499](https://arxiv.org/html/2503.14499v3)
- [MEASURED] Time Horizon 1.1, released 29 Jan 2026, puts the post-2023 doubling time at **131 days** (vs. 165 days under TH1), meaning progress is about 20% faster. The 2019-2025 trend stays at about 196 days (~7 months). TH1.1 doubled the number of 8h+ tasks (14 to 31), but human baseline times exist for only 5 of the 31 long tasks — [METR, Time Horizon 1.1 (via search extract)](https://metr.org/blog/2026-1-29-time-horizon-1-1/)
- [MEASURED/secondary] METR's published 2024-onward fit reportedly doubles in **105 days**. The AI Futures Project's Q1 2026 update revised its assumed METR doubling time from 5.5 months to 4 months (Kokotajlo) and 4.5 months (Lifland) — [AI 2027 Tracker](https://ai2027-tracker.com/predictions/metr-doubling/)
- [SECONDARY] One tracker puts the recent rate at about 130 days per doubling, which it calls "the 10x-a-year clock" — [AGI Tracker blog](https://agitracker.io/blog/metr-time-horizons-2026/)

**Data points (late 2025 to 2026)**
- [MEASURED] Claude Opus 4.5 (Dec 2025): 50% horizon of about **4h49m** (95% CI 1h49m to 20h25m). This was METR's highest published horizon at the time. Its 80% horizon was about 27 min — [METR on X](https://x.com/METR_Evals/status/2002203627377574113); [Rohan Paul summary](https://x.com/rohanpaul_ai/status/2003142187295691118)
- [MEASURED] Opus 4.5 re-measured on TH1.1 came out at about **5h20m** — [Ajeya Cotra, "I underestimated AI capabilities (again)"](https://www.planned-obsolescence.org/p/i-underestimated-ai-capabilities)
- [MEASURED, secondary] GPT-5 (Aug 2025) appears as 2h18m in one column and 3h34m in another on the Wikipedia METR table. Which column is TH1 and which is TH1.1 was not confirmed — [Wikipedia: METR](https://en.wikipedia.org/wiki/METR)
- [MEASURED, secondary] **Claude Mythos** (best model per Wikipedia as of May 2026): 50% horizon **at least 16 hours**, 80% horizon **about 3h06m**. METR says measurements above 16h are unreliable with its current suite — [Wikipedia: METR](https://en.wikipedia.org/wiki/METR)
- [MEASURED, secondary] An early Mythos Preview tested in March 2026 reportedly scored a 50% horizon of about **17.4h** (95% CI about 8.5h to 55h) and an 80% horizon of about 185.9 min. METR's Frontier Risk Report reportedly said the strongest Feb-Mar 2026 agents **saturate TH1.1**, with a 50% point estimate of about 16-20h — [AGI Tracker blog (search extract)](https://agitracker.io/blog/metr-time-horizons-2026/)
- [CRITIQUE] An Oct 2026 statistical critique on arXiv argues that the headline time-horizon plot depends heavily on task selection and fitting choices. Error bars are about 2x in either direction — [On the estimation and validity of AI time horizons, arXiv 2610.12466](https://arxiv.org/pdf/2610.12466v1)
- [CONTEXT] A July 2026 arXiv paper discusses two AI metrics that diverged. It was not read in full — [arXiv 2607.00913](https://arxiv.org/pdf/2607.00913)
- [EXTRAPOLATION, academic] A Nov 2025 paper models how time-horizon growth would slow if compute growth slows — [Forecasting AI Time Horizon Under Compute Slowdowns, arXiv 2511.19492](https://arxiv.org/html/2511.19492v1)

**METR caveats on real-world transfer (developer RCT)**
- [MEASURED] In METR's early-2025 RCT, experienced open-source developers took **19% longer** with AI (CI +2% to +39%) while believing they were sped up — [TechCrunch, Jul 2025](https://techcrunch.com/2025/07/11/ai-coding-tools-may-not-speed-up-every-developer-study-shows)
- [MEASURED] METR's follow-up ran from August 2025 with 57 developers, 143 repos and 800+ tasks. Returning developers showed an estimated **18% speedup** (CI -38% to +9%, time-ratio metric); new recruits showed about 4%. METR calls this an **"unreliable signal"**. Many developers refused to work without AI, which likely biases the estimate downward, and pay was lowered from $150/hr to $50/hr. METR judges that developers are "likely" more sped up in early 2026 than in early 2025, but the data are "only very weak evidence" of how much. METR is redesigning the experiment — [METR, 24 Feb 2026, "We are Changing our Developer Productivity Experiment Design"](https://metr.org/blog/2026-02-24-uplift-update/)
- [MEASURED, self-report] METR's May 2026 survey found median **perceived** uplift of about 1.4x to 2x among technical workers in early 2026. METR staff reported lower uplift than other respondents — [METR, 11 May 2026](https://metr.org/blog/2026-05-11-ai-usage-survey/)

### Inferences
- **[EXTRAPOLATION — my own arithmetic, not a METR forecast]** Projected forward from about 16h (50%) and about 3h (80%) in March 2026, assuming the trend continues and task suites can still measure it:

| Date | Fast: 4-mo doubling (8x/yr), 50% horizon | Base: 131-day doubling (~6.9x/yr), 50% | Slow: 7-mo doubling (~3.3x/yr), 50% | Base 80% horizon (~5x below 50%) | Slow 80% horizon |
|---|---|---|---|---|---|
| Mar 2026 (measured) | ~16h | ~16h | ~16h | ~3h | ~3h |
| Mar 2027 | ~128h (~3 work-weeks) | ~110h (~2.75 work-weeks) | ~52h (~1.3 work-weeks) | ~21h (~2.5 work-days) | ~10h |
| Mar 2028 | ~1,000h (~6 work-months) | ~760h (~4.5 work-months) | ~170h (~1 work-month) | ~145h (~3.5 work-weeks) | ~32h (~4 work-days) |
| Mar 2029 | ~8,000h (~4 work-years) | ~5,200h (~2.5 work-years) | ~570h (~3.5 work-months) | ~1,000h (~6 work-months) | ~106h |
| Mar 2030 | off-scale | off-scale | ~1,850h (~11 work-months) | off-scale | ~350h (~2 work-months) |
| Mar 2031 | off-scale | off-scale | ~6,000h (~3 work-years) | off-scale | ~1,150h |

- Applied mechanically, the trend already implies that by **late 2026 / early 2027** frontier agents complete **day-to-week-long** well-specified software/research tasks half the time, and **multi-hour tasks at 80%**. For Copilot, that means agents can plausibly take on bounded, multi-step office tasks such as building a model, a deck, or a report from sources with periodic check-ins. Fully unsupervised week-long work stays unreliable through at least 2027 in the slow case.
- Beyond about 2028, the extrapolation stops being meaningful for three reasons: (a) METR's suite saturates at about 16h, so new benchmarks are needed; (b) the 2x error bars compound; (c) at month-scale horizons the binding constraints become organizational context, data access, and verification rather than raw capability.
- The 50%-to-80% gap (about 5x in early 2026, wider in 2025: 4h49m vs 27m for Opus 4.5, about 10x) is the most decision-relevant number for enterprise copilots. Products tend to need 80-99% reliability, which runs a year or more behind headline 50% capability.
- The RCT history suggests a **1-2 year lag** between benchmark capability and measured productivity gains in real codebases.

### Gaps
- METR's own 2026 pages could not be fetched (DNS failure). The Mythos figures (16h vs 17.4h) and the "Frontier Risk Report" saturation claim come from Wikipedia and secondary extracts and should be checked on metr.org.
- No 2026 METR measurements for OpenAI's latest models (GPT-5.4/5.5) or Microsoft MAI models were found.
- No METR data on time horizons for non-software office tasks such as spreadsheets, documents, or email. METR's horizons are measured on software and ML-research tasks.

---

## 2. Epoch AI: compute scaling, training runs, inference cost declines, and constraints through 2030

### Takeaway
Epoch projects that training compute can keep growing about 4-5x per year through 2030, reaching training runs of about 1e29-2e29 FLOP. Power is the first binding constraint, followed by chip manufacturing. Price per unit of capability is falling about 13x per year at fixed performance (Sept 2026 estimate), and fastest at the frontier. Whatever a top model can do in year N, Copilot can likely run cheaply at scale in year N+1 to N+2.

### Cited Findings
- [EXTRAPOLATION, Epoch 2024] Training runs of about **2e29 FLOP are likely feasible by 2030**. Power is the constraint most likely to bind first, followed by chip manufacturing capacity. Epoch's power scenarios range from about 1 GW (single site) to about 45 GW (distributed) — [Epoch, "Can AI scaling continue through 2030?"](https://epoch.ai/publications/can-ai-scaling-continue-through-2030)
- [EXTRAPOLATION, Epoch 2025] Training compute is expected to keep growing about 4-5x per year. Limits on training-run duration could slow compute scaling — [Epoch, "How much power will frontier AI training demand in 2030?"](https://epoch.ai/publications/power-demands-of-frontier-ai-training)
- [EXTRAPOLATION, Epoch 2025] Power is unlikely to bind before 2028 and looks solvable after that — [Epoch, "What will AI look like in 2030?"](https://epoch.ai/blog/what-will-ai-look-like-in-2030)
- [TRAINING-KNOWLEDGE] Frontier training compute grew about 4-5x per year from 2010 to 2024 — [Epoch, "Training compute of frontier AI models grows by 4-5x per year"](https://epoch.ai/blog/training-compute-of-frontier-ai-models-grows-by-4-5x-per-year)
- [TRAINING-KNOWLEDGE] Epoch (2024) estimated that the stock of high-quality public human-generated text will be fully used for training at some point between about **2026 and 2032**. Synthetic data and RL on verifiable tasks are the main proposed workarounds — [Epoch, "Will we run out of data?"](https://epoch.ai/blog/will-we-run-out-of-data-limits-of-llm-scaling-based-on-human-generated-data)
- [EXTRAPOLATION, 2026] The International AI Safety Report 2026 estimates that the largest 2030 training runs would need about **4-16 GW**. It judges buildout likely sufficient for runs of about 10 GW, so energy is unlikely to block scaling before the end of the decade — [International AI Safety Report 2026, arXiv 2602.21012](https://arxiv.org/pdf/2602.21012)
- [MEASURED, Epoch Sept 2026] The price to reach a fixed performance level is falling about **47% per quarter, about 13x per year**, since 2023 across five benchmarks. Math falls fastest at 50-52%/quarter, strategy games slowest at 39-43%. Declines are steepest for newly reached capability levels: **66%/quarter at state of the art**, slowing to 32%/quarter two years later — [Pillitteri summary of Epoch report](https://pasqualepillitteri.it/en/news/21044/epoch-ai-ai-prices-fall-47-percent-quarter); [Epoch, "The plunging price of thought"](https://epoch.ai/publications/the-plunging-price-of-thought)
- [MEASURED, Epoch Mar 2025] Earlier Epoch work found the price to reach a given benchmark score falling **9x to 900x per year**, depending on benchmark and threshold — [Epoch data insight](https://epoch.ai/data-insights/llm-inference-price-trends); [Epoch on X](https://x.com/EpochAIResearch/status/1900264630473417006)
- [MEASURED, 2026 paper] Gundlach et al. (Mar 2026) estimate **5-10x per year** declines — [cited in Epoch report summary](https://pasqualepillitteri.it/en/news/21044/epoch-ai-ai-prices-fall-47-percent-quarter)
- [CAVEAT] Cheaper per-token models can use far more tokens per task, so cost "from question to correct answer" may not fall as fast as list price — [Epoch report summary](https://pasqualepillitteri.it/en/news/21044/epoch-ai-ai-prices-fall-47-percent-quarter); [DEV Community, "LLM Inference Prices Fell 280x. Your Bill Did Not"](https://dev.to/jamilxt/llm-inference-prices-fell-280x-your-bill-did-not-how-to-find-the-efficient-frontier-20n5)

### Inferences
- If compute grows about 4-5x per year, 2030 frontier training runs would be about 1,000-3,000x larger than the 2025 frontier. That is the hardware basis for the base and fast scenarios.
- At about 13x per year, a capability that costs $X per task at the frontier in late 2026 would cost about X/13 by late 2027 and about X/170 by late 2028. For Copilot's flat per-seat economics, this means frontier-grade agentic features move from premium tiers to mass deployment on about a 12-24 month lag. Long agentic runs consume many more tokens, which partly offsets the price decline. OpenAI researchers already spend $600+/day each on inference (Section 4).
- The slow scenario's main hardware mechanism is power or chip delays after 2028, together with exhaustion of public text data. Epoch's own view is that these constraints likely bind softly, not as a hard wall.

### Gaps
- No Epoch 2026 update to the 2e29 FLOP / 2030 feasibility analysis was found. Epoch's current estimate of the largest training run to date (2026) was not retrieved.
- No Epoch-specific figures on the Microsoft/OpenAI/Anthropic 2026 data-center buildout were retrieved.

---

## 3. AI 2027 scenario, AI Futures Project revisions, Metaculus and other forecasters

### Takeaway
AI 2027 (April 2025) predicted a superhuman coder in early 2027 and superintelligence by late 2027. Its authors lengthened timelines in Dec 2025, then shortened them again in 2026 as METR trends sped up. As of Aug 2026, their medians for full coding automation run from **Nov 2027 (Kokotajlo) to Jan 2030 (Lifland)**, and they judge reality to be running at about **70-90% of AI 2027's pace**. Metaculus community medians are about **2028 for "weakly general AI"** and about **2031-2033 for strong AGI**.

### Cited Findings
- [OPINION/FORECAST, Apr 2025] The original AI 2027 scenario: a superhuman coder around early 2027, a superhuman AI researcher mid-2027, and ASI by end-2027 (the "race" ending). At publication the authors said their own medians were somewhat later (Kokotajlo about 2028) — [AI Futures Project, Wikipedia](https://en.wikipedia.org/wiki/AI_Futures_Project); [ai-2027.com tracker](https://ai2027-tracker.com/changelog/)
- [OPINION/FORECAST, Dec 2025] The December 2025 update **lengthened** timelines to full coding automation by about **3-5 years** relative to AI 2027 — [Timelines shrink in AI Futures quarterly update](https://aistop.watch/p/timelines-shrink-in-ai-futures-quarterly); [AI Futures blog, Q1 2026 update](https://blog.aifutures.org/p/q1-2026-timelines-update)
- [OPINION/FORECAST, Q1 2026] The Q1 2026 update **shortened** the Automated Coder medians: Kokotajlo from late 2029 to **mid-2028**, Lifland from early 2032 to **mid-2030**. It also revised the assumed METR doubling time from 5.5 to about 4-4.5 months — [AI Futures blog, Q1 2026 Timelines Update](https://blog.aifutures.org/p/q1-2026-timelines-update); [AI 2027 Tracker](https://ai2027-tracker.com/predictions/metr-doubling/)
- [OPINION/FORECAST, 16 Aug 2026] The Q2.5 2026 update, "Uplift and Revenue", shortened timelines slightly:
  - Automated Coder medians: Kokotajlo **Nov 2027** (from May 2028), Brendan **Jan 2029**, Lifland **Jan 2030**. These are conditional on development proceeding as fast as technically feasible.
  - The authors judge that reality is running at **about 70-90% of AI 2027's predicted speed**.
  - Their simple uplift model assumes 20x AI R&D uplift at the Automated Coder milestone; the full AI Futures Model uses 32x in the median case.
  — [AI Futures blog, Q2.5 2026 Timelines Update](https://blog.aifutures.org/p/q25-2026-timelines-update-uplift)
- [OPINION/FORECAST, secondary] Per a secondary write-up of the Q2.5 update, Kokotajlo's ASI median moved to **2029** (from 2030) and Lifland's to **2033** (from 2035). Not verified against the primary post — [aistop.watch](https://aistop.watch/p/timelines-shrink-in-ai-futures-quarterly)
- [ASSESSMENT] The AI Futures Project graded AI 2027's 2025 predictions — [Grading AI 2027's 2025 Predictions](https://blog.aifutures.org/p/grading-ai-2027s-2025-predictions)
- [FORECAST AGGREGATE] Metaculus "weakly general AI" (cognitive-only, no robotics): median **June 2028** as of mid-July 2026 (secondary source) — [AIToolsReview, Sep 2026](https://aitoolsreview.co.uk/insights/agi-timeline-predictions-2026)
- [FORECAST AGGREGATE] Metaculus "Date of AGI" (four-condition strong test, including robotics): the page showed about **Feb 2031** (range Apr 2028 to Apr 2037). Earlier snapshots showed a Jan 2033 median, and a Feb 2026 snapshot gave about 25% by 2029 and 50% by 2033. The differences reflect snapshot dates — [Metaculus Q5121](https://www.metaculus.com/questions/5121/date-of-artificial-general-intelligence/); [LessWrong, Forecasting AGI](https://www.lesswrong.com/posts/dRbvHfEwb6Cuf6xn3/forecasting-agi-insights-from-prediction-markets-and-1)
- [FORECAST AGGREGATE] Metaculus also hosts a "Transformative AI date" question — [Metaculus Q19356](https://www.metaculus.com/questions/19356/transformative-ai-date/)

### Inferences
- The forecasting community converged during 2026. Even the more cautious AI Futures author (Lifland) now has full coding automation around 2030, and the fastest (Kokotajlo) has it in late 2027. Mainstream crowd forecasts (Metaculus) put weak AGI around 2028. All of these fall inside the Copilot five-year window.
- "Reality runs at 70-90% of AI 2027's pace" implies that AI 2027's milestones, shifted about 1-2 years later, are a reasonable fast scenario.
- These forecasts are conditional on "no major slowdown" (for example regulation, compute disruption, or deliberate pauses), so they work as upper-middle scenarios, not unconditional medians.

### Gaps
- The AI Futures blog could not be fetched directly. The Q2.5 figures come from search extracts.
- No Metaculus question specifically on office/knowledge-work automation was found. No Polymarket or Kalshi numbers were verified.

---

## 4. Frontier lab statements and which have been tested

### Takeaway
All three relevant labs publicly expect transformative capability within the Copilot five-year window: Anthropic (powerful AI about 2026-2028), OpenAI (automated AI researcher by March 2028), and Google DeepMind (AGI about 2030). OpenAI claims it met its September 2026 "AI research intern" goal. That claim is self-defined and self-graded. Microsoft has started building its own frontier models (MAI) and is reducing its dependence on OpenAI.

### Cited Findings
**OpenAI**
- [OPINION/FORECAST, Oct 2025] Altman: "We have set internal goals of having an **automated AI research intern by September of 2026** running on hundreds of thousands of GPUs, and a **true automated AI researcher by March of 2028**. We may totally fail at this goal" — [Sam Altman on X](https://x.com/sama/status/1983584366547829073); [TechCrunch](https://techcrunch.com/2025/10/28/sam-altman-says-openai-will-have-a-legitimate-ai-researcher-by-2028/)
- [LAB CLAIM — TESTED, Sept 2026] OpenAI posted on **6 Sept 2026** that it had met the intern goal, defined as "a system that can carry out well-defined research tasks under human direction, including tasks that would take a skilled researcher a few days." Reported metrics: the research org logs **3.1 agent-workdays per human workday**; the median researcher runs **$600+/day** in inference; total agent runtime was still below human labor before June 2026. A critic notes that **more than half of the successful 4-8 hour tasks involved at least one human intervention** — [AI Weekly](https://aiweekly.co/alerts/openai-says-it-hit-automated-research-intern-milestone); [GearLive, "...and Graded Its Own Work"](https://www.gearlive.com/news/article/openai-automated-research-intern-milestone)
- [LAB CLAIM, 29 Sept 2026 DevDay] Altman: "A few weeks ago we reached that goal. We now have an AI research intern." Post-training lead Tejal Patwardhan said the models complete **more than a third of day-long research tasks with no human help** — [The Next Web (via search extract)](https://thenextweb.com/news/sam-altman-openai-ai-research-intern-devday-keynote)
- [TRAINING-KNOWLEDGE, Jun 2025] Altman, "The Gentle Singularity": 2025 brings agents doing real cognitive work, **2026 likely systems that can figure out novel insights**, and 2027 possibly robots doing real-world tasks — [blog.samaltman.com](https://blog.samaltman.com/the-gentle-singularity)

**Anthropic**
- [TRAINING-KNOWLEDGE, Oct 2024] Amodei, "Machines of Loving Grace": "powerful AI" (smarter than a Nobel laureate in most fields, able to work autonomously on tasks lasting hours to weeks) could arrive **as early as 2026** — [darioamodei.com](https://darioamodei.com/machines-of-loving-grace)
- [TRAINING-KNOWLEDGE, Mar 2025] Anthropic told the US government (OSTP) it expects powerful AI systems to emerge in **late 2026 or early 2027** — [Anthropic, Recommendations to OSTP](https://www.anthropic.com/news/anthropic-s-recommendations-ostp-u-s-ai-action-plan)
- [OPINION/FORECAST, Jan 2026] Amodei's essay "The Adolescence of Technology" says powerful AI able to do most or all jobs will arrive in "much less than five years". It calls a "country of geniuses in a datacenter" potentially "the single most serious national security threat" in a century and restates a 1-5 year window for entry-level job disruption — [darioamodei.com](https://darioamodei.com/essay/the-adolescence-of-technology)
- [OPINION/FORECAST, 2026] Dwarkesh Patel interview, "We are near the end of the exponential":
  - On coding: "we'll be there in one or two years".
  - One summary reports about 90% confidence in a country of geniuses within 10 years; another reports a personal estimate of 1-3 years.
  - A transcript excerpt places the "country of geniuses" in **2028**.
  — [Dwarkesh Podcast](https://www.dwarkesh.com/p/dario-amodei-2); [study notes summary](https://snowan.gitbook.io/study-notes/ai-blogs/dario-amodei-end-of-exponential-dwarkesh-2026); [VC Corner](https://www.thevccorner.com/p/dario-amodei-agi-1-3-years-full-breakdown)
- [OPINION/FORECAST] On jobs: in May 2025 (Axios), Amodei said AI could eliminate **half of entry-level white-collar jobs** and push unemployment to **10-20% within 1-5 years**. At Davos (Jan 2026) he reportedly repeated that AI could replace software engineers within a year and eliminate half of white-collar jobs within five. Economists have pushed back — [TheStreet](https://www.thestreet.com/technology/anthropic-ceo-makes-shocking-admission-about-ai); [Axios](https://www.axios.com/newsletters/axios-am-e8b4908f-a6fa-40b1-8adc-7d9b60c94da2)
- [TEST STATUS] The "late 2026/early 2027 powerful AI" prediction is being tested now. By Oct 2026, frontier models reach about 16h+ 50% horizons (Section 1), but the 80% horizon is about 3h and measured real-world uplift is ambiguous (METR RCT). That is not yet "Nobel-level, autonomous for weeks". The prediction is not yet falsified, but its "as early as 2026" end looks unlikely to be met in full.

**Google DeepMind**
- [OPINION/FORECAST, Mar 2025] Hassabis: AI that matches humans at any task in **5-10 years** — [CNBC](https://www.cnbc.com/2025/03/17/human-level-ai-will-be-here-in-5-to-10-years-deepmind-ceo-says.html)
- [OPINION/FORECAST, 2026] In 2026 interviews (20VC, Y Combinator), Hassabis is reported as betting on **AGI within about five years, around 2030**. He names the missing pieces as **continual learning** ("current systems are trained, and then they are essentially frozen"), **long-term coherent planning**, and **real structured long-term memory** ("not just a context window"). He gives about 50/50 odds that one or two fundamental algorithmic ideas are still undiscovered. All of these are secondary summaries — [CO/AI 20VC summary](https://getcoai.com/clear-channel/20vc-deepminds-demis-hassabis-on-agi-scaling-laws-and-the-10x-industrial-revolution/); [BigGo Finance](https://finance.biggo.com/news/cfe7765782e4b9eb); [PANews YC summary](https://www.panewslab.com/en/articles/019dde05-2a76-7628-955f-3976151af4d5); [DEV Community](https://dev.to/oug/deepminds-ceo-says-agi-may-be-4-years-away-the-last-three-missing-pieces-are-not-what-most-19dl)

**Microsoft (MAI)**
- [FACT] In Nov 2025, Microsoft formed the MAI Superintelligence team under Mustafa Suleyman with a "humanist superintelligence" framing — [Axios](https://www.axios.com/2025/11/06/microsoft-mustafa-suleyman-superintelligence)
- [FACT, secondary] In March 2026, Suleyman's mandate narrowed: Jacob Andreou now leads the Copilot division and reports to Nadella, while Suleyman runs MAI Superintelligence. Microsoft released MAI-Transcribe-1, MAI-Voice-1 and MAI-Image-2 in April 2026 — [Wikipedia: Microsoft AI](https://en.wikipedia.org/wiki/Microsoft_AI); [The Next Web](https://thenextweb.com/news/microsoft-mai-models-openai-independence)
- [FACT, secondary, unverified] Around Build / June 2026, MAI reportedly released seven in-house models, including MAI-Thinking-1 (reasoning, private preview on Foundry) and MAI-Code-1-Flash (rolling out in VS Code / GitHub Copilot). Suleyman says Microsoft was "set free from our contract with OpenAI ... to formally pursue superintelligence" — [StartupHub](https://www.startuphub.ai/ai-news/ai-figures/2026/figure-mustafa-suleyman-recent-appearance-recap-2026-07-14); [Wikipedia: Microsoft AI](https://en.wikipedia.org/wiki/Microsoft_AI); [Business Engineer](https://businessengineer.ai/p/has-microsoft-just-entered-the-frontier)

### Inferences
- The lab predictions cluster tightly: "AI researcher/coder automation" lands in 2027-2028 and "AGI / country of geniuses" in 2028-2030. Labs have an incentive to overstate, so these are best read as the **fast scenario**.
- The OpenAI intern milestone is the clearest tested prediction. It was met on OpenAI's own definition, with heavy human-in-the-loop caveats. That pattern (headline targets met via generous definitions, with real autonomy lagging) is a useful template for reading 2027-2028 claims.
- For Copilot: MAI's public models in 2026 are mostly modality and small/fast models, not frontier reasoning leaders. So through at least 2027, Copilot's top-end capability likely still depends on OpenAI and Anthropic models. This is an inference from the model lineup, not a sourced statement.

### Gaps
- No primary OpenAI post text was retrieved for the Sept 2026 intern claim (DNS / search extract only).
- How exactly Copilot routes between OpenAI, Anthropic and MAI models in 2026 was not established here.
- Amodei's "90% of code in 3-6 months" (Mar 2025) claim was not checked against 2026 evidence in this session.

---

## 5. Computer-use (OSWorld, WebArena) and office-task (GDPval) benchmark progress, 2024-2026

### Takeaway
Computer use went from about 12-15% on OSWorld (2024) to **above the 72% human baseline** on OSWorld-Verified in 2026. Top agent-scaffold entries report about 83-90%, but the harder OSWorld 2.0 shows full completion around 44%. On GDPval (expert-graded, economically valuable office deliverables), win-or-tie rates against industry professionals rose from about 48% (Claude Opus 4.1, Sept 2025) to a reported about **80-85% (GPT-5.5 / Claude Opus 4.7, Apr 2026)**. By contrast, the Remote Labor Index (real freelance projects) found only **2.5%** of projects fully automatable in late 2025.

### Cited Findings
**OSWorld / computer use**
- [TRAINING-KNOWLEDGE, Apr 2024] OSWorld launched with a human baseline of **72.36%** and the best model at **12.24%** — [OSWorld paper, arXiv 2404.07972](https://arxiv.org/abs/2404.07972)
- [TRAINING-KNOWLEDGE, Oct 2024] Claude 3.5 Sonnet (new), the first frontier "computer use" model, scored **14.9%** on OSWorld (screenshot-only) — [Anthropic](https://www.anthropic.com/news/3-5-models-and-computer-use)
- [MEASURED, conflicting] OpenAI's Operator / Computer-Using Agent (Jan 2025): OpenAI's launch post reported **38.1%** OSWorld and 58.1% WebArena (training knowledge); a leaderboard lists **32.6%** at 50 steps. The difference is likely the step-budget configuration — [OpenAI CUA](https://openai.com/index/computer-using-agent/); [Steel.dev OSWorld leaderboard](https://leaderboard.steel.dev/leaderboards/osworld/)
- [MEASURED] Anthropic Sonnet series on OSWorld: Claude 3.7 Sonnet **28.0%**, Claude Sonnet 4 **42.2%**, Claude Sonnet 4.5 (Sept 2025) **61.4%** on OSWorld-Verified, Claude Opus 4.5 **66.3%**, Claude Sonnet 4.6 **72.5%** and Opus 4.6 **72.7%** (early 2026, at about human baseline) — [Leanware](https://leanware.co/insights/claude-sonnet-4-5-overview); [Pillitteri (Sonnet 4.6)](https://pasqualepillitteri.it/news/280/claude-sonnet-4-6-modello-ai-flagship); [BenchLM](https://benchlm.ai/benchmarks/osworld)
- [VENDOR CLAIM, May 2026] Pointer reports **83.6%** on OSWorld-Verified with Claude Opus 4.7 — [Pointer](https://www.pointer.ai/blog/sota)
- [SECONDARY, Oct 2026] The top official OSWorld-Verified leaderboard entry is reportedly Intelligence-Indeed Agent at **90.19%**. Coasty claims **82.81%**. On the harder **OSWorld 2.0**, the best official entry reportedly fully completes about **44%** of tasks (human baseline about 70%) — [presenc.ai, 1 Oct 2026](https://presenc.ai/research/osworld-computer-use-leaderboard-2026); [Coasty](https://coasty.ai/blog/osworld-benchmark-results-2026-ai-computer-use-agents-ranked-20260504); [BenchLeader OSWorld 2.0](https://www.benchleader.com/benchmarks/osworld_2); [LLMLearner, Sep 2026](https://llmlearner.com/rankings/osworld-verified)
- [CONTEXT] Explainer on what "beating humans" on OSWorld means — [Omniscient](https://www.omniscient.media/post/what-does-it-mean-for-ai-to-beat-humans-at-using-a-computer-a-beginner-s-guide-to-osworld)

**GDPval (office and professional deliverables)**
- [MEASURED, Sept/Oct 2025] GDPval covers 44 occupations across the 9 largest US GDP sectors, with blind pairwise grading by industry experts (about 14 years of experience on average). Best model: **Claude Opus 4.1 at 47.6% win-or-tie** on the gold set. GPT-5 scored about 40.6% (training knowledge). Paper accepted at ICLR 2026 — [GDPval, arXiv 2510.04374](https://arxiv.org/html/2510.04374v1); [ICLR 2026 paper note](https://en.papernotes.org/ICLR2026/llm_evaluation/gdpval_evaluating_ai_model_performance_on_real-world_economically_valuable_tasks/)
- [TRAINING-KNOWLEDGE, Dec 2025, unverified this session] OpenAI reported GPT-5.2 Thinking beating or tying professionals on about **70.9%** of GDPval tasks — [OpenAI GPT-5.2 launch](https://openai.com/index/introducing-gpt-5-2/)
- [LAB CLAIM, Apr 2026] Launch-post win-or-tie rates sampled 23 Apr 2026: **GPT-5.5 84.9%**, GPT-5.4 83.0%, **Claude Opus 4.7 80.3%** — [BenchmarkList GDPval](https://benchmarklist.com/benchmarks/openai_gdpval/); [Actrix, "Are LLMs now at par with industry experts?"](https://actrixft.com/are-llms-now-at-par-with-industry-experts-what-the-latest-gdpval-results-show/)
- [SECONDARY, unverified] Artificial Analysis runs a separate GDPval-AA Elo leaderboard. An aggregator lists a Sept 2026 Claude Opus 5.5 at Elo 1846 (v2.1). There is also a GDPval-MM variant. These metrics are **not comparable** to the expert win rate — [LLM-Stats GDPval-MM](https://llm-stats.com/benchmarks/gdpval-mm); [It Does What Now: GDPval explainer](https://itdoeswhatnow.com/benchmarks/gdpval/)
- [INTERPRETATION] A wins-only score of 50% means parity with the expert. Wins-plus-ties measures "at least as good" — [BenchmarkList](https://benchmarklist.com/benchmarks/openai_gdpval/)

**Real freelance work**
- [MEASURED, Oct 2025] Remote Labor Index (Scale AI + CAIS): 240 real freelance projects across 23 categories. The best agent (Manus) achieved a **2.5% automation rate**, with GPT-5, Claude Sonnet 4.5, Grok 4, Gemini 2.5 Pro and ChatGPT agent lower. Elo shows steady relative improvement. Evaluators agreed 94.4% of the time — [RLI, arXiv 2510.26787](https://arxiv.org/abs/2510.26787); [Scale AI](https://scale.com/research/rli)

### Inferences
- On OSWorld-class desktop tasks, computer use roughly went from **15% to about 72% (human parity) in about 18 months** (Oct 2024 to early 2026), then into the 80s-90% range with specialized scaffolds. For Copilot's UI-agent features (Copilot Actions, Researcher/Analyst agents, Windows agentic features), single-session app-navigation competence is no longer the main bottleneck in late 2026. Harder multi-app, long-horizon tasks (OSWorld 2.0 at about 44%) and reliability are.
- GDPval near 80-85% win-or-tie in 2026 indicates that **single, well-specified deliverables** (memo, spreadsheet model, slide deck), when graded blind, are at or above professional quality most of the time. The RLI result shows that **end-to-end real projects** with messy specs were still largely not automatable in late 2025. The gap between "one deliverable" and "a whole job" is the crux for Copilot through 2028.
- Base-case extrapolation: OSWorld 2.0-class tasks likely reach human parity by about 2027-2028, and RLI-type full-project automation might reach tens of percent by about 2028 if horizon trends hold. This is speculative.

### Gaps
- No 2026 Remote Labor Index results were found.
- No 2026 WebArena numbers were found. WebArena largely fell out of focus as top agents saturated it in 2025 (training knowledge; not verified).
- No independent (non-lab) replication of the 2026 GDPval scores was found.

---

## 6. Strongest skeptical arguments, and slow, base, and fast scenarios

### Takeaway
The best skeptical case is not "progress stops". It is (1) reliability: 80%+ horizons lag 50% horizons by about 5-10x; (2) the benchmark-to-real-work gap: RLI 2.5%, ambiguous RCT uplift; (3) measurement fragility: METR suite saturation and 2x error bars; (4) structural missing pieces: continual learning and memory, per Hassabis; (5) physical constraints after 2028. Each of these widens the time between "model can do it in a demo" and "Copilot can do it unsupervised for enterprises".

### Cited Findings
- [MEASURED] Reliability gap: Opus 4.5 50% horizon 4h49m vs 80% horizon about 27 min (Dec 2025). Mythos about 16h vs about 3h (2026) — [METR on X](https://x.com/METR_Evals/status/2002203627377574113); [Wikipedia: METR](https://en.wikipedia.org/wiki/METR)
- [MEASURED] Real-world gap: RLI 2.5% automation of real freelance projects (late 2025) — [arXiv 2510.26787](https://arxiv.org/abs/2510.26787). The METR RCT showed a 19% slowdown in early 2025, and the 2026 follow-up was inconclusive — [METR Feb 2026](https://metr.org/blog/2026-02-24-uplift-update/)
- [MEASURED] Human-intervention caveat: more than half of OpenAI's successful 4-8h "intern" tasks needed at least one human intervention — [GearLive](https://www.gearlive.com/news/article/openai-automated-research-intern-milestone)
- [CRITIQUE] Methodological fragility: time-horizon estimates depend heavily on task selection and fitting choices — [arXiv 2610.12466](https://arxiv.org/pdf/2610.12466v1). TH1.1 has human baselines for only 5 of 31 long tasks — [METR TH1.1](https://metr.org/blog/2026-1-29-time-horizon-1-1/)
- [OPINION] Missing capabilities: continual learning, long-horizon planning, and structured long-term memory. About 50/50 odds that new algorithmic ideas are needed — Hassabis, via [CO/AI](https://getcoai.com/clear-channel/20vc-deepminds-demis-hassabis-on-agi-scaling-laws-and-the-10x-industrial-revolution/); [BigGo](https://finance.biggo.com/news/cfe7765782e4b9eb)
- [EXTRAPOLATION] Physical and data constraints: power binds first, then chips (Epoch). Public text data is exhausted around 2026-2032 (Epoch, training knowledge) — [Epoch 2030](https://epoch.ai/publications/can-ai-scaling-continue-through-2030); [Epoch data](https://epoch.ai/blog/will-we-run-out-of-data-limits-of-llm-scaling-based-on-human-generated-data). Compute slowdowns would slow horizon growth — [arXiv 2511.19492](https://arxiv.org/html/2511.19492v1)
- [CAVEAT] Token-hungry agents erode per-token price declines — [DEV Community](https://dev.to/jamilxt/llm-inference-prices-fell-280x-your-bill-did-not-how-to-find-the-efficient-frontier-20n5)
- [OPINION] Economists have pushed back on Amodei's job-loss claims — [TheStreet](https://www.thestreet.com/technology/anthropic-ceo-makes-shocking-admission-about-ai)
- [ACCELERATION EVIDENCE] OpenAI's research org reportedly logs 3.1 agent-workdays per human workday (Sept 2026). The AI Futures model assumes 20-32x AI R&D uplift at the automated-coder milestone. Self-reported technical-worker uplift was about 1.4-2x in early 2026 (METR survey) — [AI Weekly](https://aiweekly.co/alerts/openai-says-it-hit-automated-research-intern-milestone); [AI Futures Q2.5](https://blog.aifutures.org/p/q25-2026-timelines-update-uplift); [METR survey](https://metr.org/blog/2026-05-11-ai-usage-survey/)
- [CONTEXT] On AI helping build AI (recursive self-improvement agenda) — [The Sequence, Issue 949](https://thesequence.substack.com/p/the-sequence-knowledge-issue-949)

### Inferences — scenario synthesis (my construction from the sources above)

**SLOW scenario (about 20-25% weight).** The METR doubling time reverts to about 7 months or longer after 2027. Compute or power slows after 2028. Continual learning remains unsolved.
- 2027: 50% horizon about 1-2 work-weeks; 80% horizon about 1 work-day.
- 2029: 80% horizon about 2-3 work-weeks.
- 2031: 80% horizon about 2 work-months.
- Copilot remains a "supervised delegate". Agents handle defined multi-hour tasks, and humans check outputs.
- AI-automates-AI-research produces only modest uplift (under 2-3x).
- Cost falls about 5x/yr.

**BASE scenario (about 50% weight).** The 4-5 month doubling continues to about 2028, then becomes hard to measure.
- 2027: 50% horizon about 2-4 work-weeks; 80% horizon about 2-3 work-days. Reliable cross-app computer use; OSWorld 2.0 at human parity.
- 2028: automated-coder-like capability in labs (AI Futures medians span Nov 2027 to Jan 2030). OpenAI's "automated AI researcher" target (Mar 2028) is met in some partial form.
- 2029-2030: weak-AGI-level systems (Metaculus median about 2028).
- Copilot can own multi-day projects end to end with sign-off checkpoints, and persistent memory or learning matures.
- Cost per fixed capability falls about 10-13x/yr.

**FAST scenario (about 25% weight).** Doubling time is 4 months or shorter, with an AI-R&D feedback loop (AI Futures: 20-32x uplift at automated coder).
- Automated coder by late 2027 (Kokotajlo median Nov 2027).
- Superhuman AI researcher in 2028.
- ASI-class systems by about 2029 (Kokotajlo's revised ASI median).
- Copilot capability is bounded mainly by deployment, governance, and trust, not model capability, from 2028 onward.
- AI 2027 milestones, shifted about 1-2 years later, are a fair template given the "70-90% of AI 2027's pace" assessment.

**Half-year milestone sketch (base case; all inference):**
- **H2 2026:** 50% horizon about 16-30h, 80% about 3-6h. OSWorld-Verified above human level. GDPval win/tie about 85%. OpenAI's "research intern" in place, with frequent human interventions.
- **H1 2027:** 50% horizon about 2-5 days, 80% about 1 day. Persistent memory products are mainstream but continual learning is immature. Frontier-Q4-2026 capability costs about 1/5 of its 2026 price.
- **H2 2027:** 50% horizon about 1-3 weeks, 80% about 2-3 days. The earliest forecaster medians for an automated coder (Kokotajlo) fall here.
- **2028:** 50% horizon about a month or more; 80% about 1 week. OpenAI's automated-researcher target (Mar 2028). Metaculus weak-AGI median (about mid-2028). Possible acceleration from AI R&D automation.
- **2029-2030:** Hassabis's about-2030 AGI and Lifland's Jan 2030 automated-coder median. Power and chip constraints begin to bind (Epoch / International AI Safety Report). Scenarios diverge sharply.
- **2031:** Metaculus strong-AGI median about Feb 2031 (range 2028-2037).

### Gaps
- No 2026 primary essays by prominent skeptics (e.g., Gary Marcus, Arvind Narayanan / Sayash Kapoor "AI as normal technology") were retrieved this session. Their arguments are therefore represented only indirectly (reliability, diffusion lag).
- No hard 2026 data on agent memory or continual-learning benchmarks was found.
- The scenario weights are my judgment, not sourced.
