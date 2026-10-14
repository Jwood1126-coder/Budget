# Microsoft 365 Copilot: Current Capabilities and Announced Roadmap (as of 2026-10-14)

Method note: Fetching full pages was blocked in this research environment. The proxy refused microsoft.com, learn.microsoft.com, techcommunity.microsoft.com and every third-party site tried. All findings below come from search-engine result summaries of the cited pages, not from reading the full pages. Where the search summary itself flagged a claim as unverified or conflicting, that is noted. Treat exact dates as "per the cited source" and re-verify against the Microsoft 365 Message Center and Roadmap before using them in decisions. Status key: GA = generally available; Preview = public or Frontier-program preview; Announced = not yet broadly shipping.

## 1. What can Copilot do today in each app (Outlook, Teams, Excel, Word/PowerPoint, SharePoint/OneDrive, Pages/Notebooks, Copilot Chat free vs. paid)?

### Takeaway
By October 2026, Copilot in Microsoft 365 is agentic by default inside the Office apps. Agent Mode in Word, Excel and PowerPoint went GA and became the default on 2026-04-22. In September 2026 the Microsoft 365 Copilot app was renamed "Microsoft Copilot" and restructured into Home (Chat + Cowork + Office), Code and Autopilot. Outlook's agentic inbox and calendar features were still Frontier preview as of the last confirmed report. Teams Facilitator is GA for core meeting features, with further rollouts scheduled for late 2026. Free (unlicensed) Copilot Chat lost in-app Word, Excel, PowerPoint and OneNote access at large tenants on 2026-04-15.

### Cited Findings
**Word / Excel / PowerPoint (Agent Mode)**
- GA 2026-04-22: Microsoft announced that "Copilot's agentic capabilities in Word, Excel, and PowerPoint are generally available," and that they are the default experience. Agent Mode was first introduced in September 2025. — [Microsoft Copilot blog, 2026-04-22](https://www.microsoft.com/en-us/copilot/blog/2026/04/22/copilots-agentic-capabilities-in-word-excel-and-powerpoint-are-generally-available/); [Satya Nadella on X](https://x.com/satyanadella/status/2047105085172511013?lang=en); [Windows Report](https://windowsreport.com/copilot-agent-mode-is-now-generally-available-in-word-excel-and-powerpoint/)
- Microsoft describes Agent Mode as "multi-step, app-native actions directly in your documents, worksheets, and presentations." In Excel, coverage says it can explore data, build and explain an analysis, and apply direct edits to the workbook. — [Microsoft Copilot blog, 2026-04-22](https://www.microsoft.com/en-us/copilot/blog/2026/04/22/copilots-agentic-capabilities-in-word-excel-and-powerpoint-are-generally-available/); [Office Watch](https://office-watch.com/2026/copilot-agent-mode-word-excel-powerpoint/)
- Limitation (third-party claim): as of April 2026, cross-app orchestration across Word, Excel and PowerPoint from one instruction was not GA. — [sagnikbhattacharya.com](https://sagnikbhattacharya.com/blog/copilot-agentic-ga-2026)
- Ignite 2025 (Nov 2025): Word Agent Mode reached GA and uses Work IQ to pull context from files, emails and meetings. Excel Agent Mode added web search and a choice between Anthropic and OpenAI models. "Word, Excel, and PowerPoint agents in chat" were also announced. — [Microsoft Ignite 2025 Book of News](https://news.microsoft.com/ignite-2025-book-of-news/); [Microsoft Copilot blog, Ignite 2025](https://www.microsoft.com/en-us/copilot/blog/2025/11/18/microsoft-ignite-2025-copilot-and-agents-built-to-power-the-frontier-firm/)
- September 2026 update: Word now shows citations for its content and has image changes. PowerPoint gains reusable "Skills" (saved prompts or tasks) and connectors. — [Microsoft Tech Community, What's New in Copilot Sept 2026](https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/what%E2%80%99s-new-in-microsoft-copilot--september-2026/4559107); [Office Watch, Sept 2026](https://office-watch.com/2026/microsoft-copilot-september-2026-update/)
- Office Watch cautions that a "September 2026" label on Microsoft's post does not mean the features shipped that month. It also reports that some roadmap items were cancelled in mid-September. — [Office Watch](https://office-watch.com/2026/microsoft-copilot-september-2026-update/)

**Outlook**
- Preview (Frontier), announced 2026-04-27: agentic Copilot in Outlook. It drafts follow-ups for unanswered emails, reschedules 1:1s when conflicts arise, and recommends which meetings to decline or convert to async. One secondary report said broader availability was planned for June 2026, but GA could not be confirmed. — [Thurrott](https://www.thurrott.com/cloud/335438/copilot-in-outlook-can-now-proactively-manage-your-inbox-and-calendar); [CyberSecurityNews](https://cybersecuritynews.com/copilot-agent-mode-for-outlook/); [WindowsForum](https://windowsforum.com/threads/agentic-copilot-in-outlook-spring-2026-triage-drafts-and-calendar-automation.421226/)
- Unlicensed users keep Copilot in Outlook with inbox and calendar grounding, regardless of tenant size. — [Purdue IT](https://it.purdue.edu/newsroom/articles/260403-microsoft-removes-in-app-copilot-chat-features-for-non-licensesd-users.php); [aguidetocloud](https://www.aguidetocloud.com/blog/microsoft-365-copilot-chat-april-2026-changes-what-admins-need-to-know/)

**Teams (meetings, Facilitator, Phone)**
- Facilitator agent: Message Center MC1155927 said Facilitator was becoming GA for Microsoft 365 Copilot users, with rollout completing by January 2026. Task management and document creation moved from preview to GA. The feature is included with the Copilot license, runs on Windows, Mac, Android, iOS and web, and external users cannot access the meeting notes it creates. — [M365 Admin (handsontek), MC1155927](https://m365admin.handsontek.net/facilitator-agent-generally-available-teams-meetings/); [Microsoft Tech Community, Facilitator](https://techcommunity.microsoft.com/blog/microsoft365insiderblog/keep-meetings-focused-and-productive-with-facilitator-in-teams/4456029)
- Conflicting report: GA was delayed from a June 2026 target to a November targeted release and mid-December 2026 worldwide GA. This may refer to a different rollout stage. Not verified. — [valueaddvc](https://valueaddvc.com/pulse/microsoft-teams-facilitator-delay-december-2026)
- Facilitator support for channel meetings is slated for September 2026, and the roadmap item was still marked "in development." — [WindowsForum](https://windowsforum.com/news/teams-facilitator-to-support-channel-meetings-in-september-2026.441932/)
- MC1429018 (updated 2026-10-12): Teams will generate "AI meeting memory files" that capture key insights from meetings for Copilot and Facilitator, replacing archive files and not storing raw meeting content. Targeted release early November 2026, GA early December 2026. — [mwpro.co.uk, MC1429018](https://mwpro.co.uk/blog/2026/10/13/mc1429018-microsoft-teams-adds-ai-meeting-memory-files-to-support-copilot-and-facilitator/)
- September 2026: a "Teams Phone agent" was announced. Details were not retrievable. — [Microsoft Tech Community, Sept 2026](https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/what%E2%80%99s-new-in-microsoft-copilot--september-2026/4559107)

**SharePoint / OneDrive**
- September 2026: GA of Copilot in SharePoint and OneDrive. Copilot Search is replacing the standard search box in SharePoint and OneDrive. — [Microsoft Tech Community, Sept 2026](https://techcommunity.microsoft.com/blog/microsoft-copilot-blog/what%E2%80%99s-new-in-microsoft-copilot--september-2026/4559107); [Office Watch](https://office-watch.com/2026/microsoft-copilot-september-2026-update/)
- SharePoint September 2026 roundup: skills that work across SharePoint and OneDrive, evaluation tools for improving skills, and the ability to ask questions about images in a document library. — [Microsoft SharePoint blog, Sept 2026](https://techcommunity.microsoft.com/blog/spblog/whats-new-in-copilot-in-sharepoint-september-2026/4535422)

**Copilot Pages / Notebooks**
- Roadmap drop, April 2026: "Notebooks-to-Office document generation." Roadmap drop, September 2026: Power BI, CSV/TSV and JPG/PNG references can be added to Copilot Notebooks. — [LevelUpM365, roadmap updates](https://levelupm365.com/2026/09/01/microsoft-365-roadmap-updates-september-2026/); [LevelUpM365 April 2026](https://levelupm365.com/2026/03/31/microsoft-365-roadmap-updates-april-2026/)
- Free Copilot Chat retains access to Copilot Pages and file upload (secondary source). — [Purdue IT](https://it.purdue.edu/newsroom/articles/260403-microsoft-removes-in-app-copilot-chat-features-for-non-licensesd-users.php)

**Copilot app / Chat (free vs. paid)**
- Rename and restructure (announced 2026-09-25): "Introducing the new Copilot with Home, Code, and Autopilot." Home combines Chat and Cowork with Office. Code "extends solution-building to every knowledge worker." Autopilot is "a persistent, proactive, and personal agent hosted in the cloud." The Microsoft 365 Copilot app is now called "Microsoft Copilot." — [Microsoft Partner Center, Sept 2026 announcements](https://learn.microsoft.com/en-us/partner-center/announcements/2026-september); [eGroup](https://egroup-us.com/news/copilot-september-2026-update/); [aguidetocloud](https://www.aguidetocloud.com/blog/microsoft-365-copilot-september-2026-updates/)
- eGroup reports that Microsoft plans for Copilot to eventually choose the route (Chat vs. Cowork) for each request automatically. — [eGroup](https://egroup-us.com/news/copilot-september-2026-update/)
- Free tier change, effective 2026-04-15 (MC1253858, published 2026-03-17): at tenants with more than 2,000 seats, unlicensed users lose Copilot Chat in Word, Excel, PowerPoint and OneNote. Smaller tenants keep standard access. Free users keep web-grounded chat plus the Word, Excel and PowerPoint agents in the Copilot app and at copilot.microsoft.com. — [Purdue IT](https://it.purdue.edu/newsroom/articles/260403-microsoft-removes-in-app-copilot-chat-features-for-non-licensesd-users.php); [SAMexpert](https://samexpert.com/copilot-chat-enterprise-restriction-april-2026/); [aguidetocloud](https://www.aguidetocloud.com/blog/microsoft-365-copilot-chat-april-2026-changes-what-admins-need-to-know/)
- Unlicensed users lose advanced reasoning and model choice in the Office apps. One analysis says this includes Agent Mode and Anthropic models. — [SAMexpert](https://samexpert.com/copilot-chat-enterprise-restriction-april-2026/)
- Vision in Microsoft 365 Copilot (release notes dated 2026-09-23): it understands context "from what you share on screen or camera." — [Microsoft 365 Copilot release notes](https://learn.microsoft.com/en-us/microsoft-365/copilot/release-notes)

### Inferences
- The analyst's company is mid-size. If it has 2,000 seats or fewer, unlicensed staff likely still have in-app Copilot Chat. Licensed users get Agent Mode, which is the main Excel and Word analysis tool for reports.
- For email analysis, Outlook Copilot summarization and drafting is broadly available. The proactive triage and calendar "agent" layer should be treated as preview until confirmed GA.

### Gaps
- Could not confirm the current GA or preview status of Python in Excel and Copilot-in-Excel Python features. The searches returned no 2026 data on them.
- Could not retrieve itemized details for the Teams Phone agent, the Word image changes, or "plugins and connector enhancements in the Copilot app" from the September 2026 post.
- Copilot Pages GA date and current Notebooks status for licensed users were not retrieved from a primary source.
- Facilitator GA status conflicts between sources: MC1155927 says complete by January 2026, while another source says mid-December 2026.

## 2. What are the built-in agents (Researcher, Analyst, Cowork, Workflows, Facilitator, Project Manager, Surveys, Scout/Autopilot) and what do they do?

### Takeaway
The core first-party agents are Researcher and Analyst (both GA since June 2025), Facilitator in Teams, Agent Mode and the Word/Excel/PowerPoint agents in chat, and Copilot Cowork, a long-running multi-tool task agent that went GA on 2026-06-16 with usage-based billing. Autopilot (first shown as Microsoft Scout at Build 2026) is an always-on background agent and was in private preview as of late September 2026. Workflows-style automation exists as scheduled prompts and Agent Builder scheduled workflows. Dedicated "Project Manager" and "Surveys" agents could not be verified in this research.

### Cited Findings
- Researcher and Analyst were GA on 2025-06-02 for all Microsoft 365 Copilot licensees, after Frontier preview in April 2025. At GA there was a combined cap of 25 Researcher and Analyst queries per month, which a secondary source said may change. — [Microsoft 365 blog, 2025-06-02](https://www.microsoft.com/en-us/microsoft-365/blog/2025/06/02/researcher-and-analyst-are-now-generally-available-in-microsoft-365-copilot/); [Northwestern IT KB](https://services.northwestern.edu/TDClient/30/Portal/KB/Article/2876/Using-Researcher-and-Analyst-Agents-in-Microsoft-365-M365-Copilot)
- Analyst "helps you analyze datasets, identify patterns, and explain findings in plain language." — [Northwestern IT KB](https://services.northwestern.edu/TDClient/30/Portal/KB/Article/2876/Using-Researcher-and-Analyst-Agents-in-Microsoft-365-M365-Copilot)
- Roadmap (April 2026 drop): "multi-model reasoning (GPT + Claude), Researcher Council." — [LevelUpM365 April 2026](https://levelupm365.com/2026/03/31/microsoft-365-roadmap-updates-april-2026/)
- Copilot Cowork reached GA on 2026-06-16 and is available worldwide to Microsoft 365 Copilot customers. It is billed per use in Copilot Credits. It is disabled by default at GA, so an admin must enable it and set spending limits. A later release note describes Cowork as "a full agentic experience for long-running, multi-tool work" with plugins, Edge browsing and cost controls. — [Microsoft Copilot blog, 2026-06-16](https://www.microsoft.com/en-us/copilot/blog/2026/06/16/copilot-cowork-is-now-generally-available/); [Microsoft Partner Center June 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-june); [Releasebot](https://releasebot.io/updates/microsoft/microsoft-copilot)
- Microsoft Scout was unveiled at Build 2026 (2026-06-02). Microsoft called it the first "Autopilot": proactive rather than reactive, running continuously in the background with its own governed Entra identity. It spans Teams, Outlook, OneDrive, SharePoint and the Windows desktop for scheduling, meeting prep and routine follow-ups. One source says it is built on OpenClaw and Work IQ. It was in private preview for Frontier organizations. Sources disagree on broader timing (late June 2026 vs. Q4 2026), and pricing was not announced. — [Microsoft Tech Community discussion](https://techcommunity.microsoft.com/discussions/microsoft-copilot/microsoft-introduces-scout-the-always-on-personal-ai-agent/4525534); [Western Computer](https://www.westerncomputer.com/resources/blog/microsoft-scout-autopilot-agent); [Rob Quickenden](https://robquickenden.blog/2026/06/what-is-microsoft-scout/); [Digital Applied](https://www.digitalapplied.com/blog/microsoft-scout-personal-ai-agent-build-2026-analysis)
- As of 2026-09-25 Autopilot is a pillar of the "new Copilot," and Autopilot is expanding to private preview at the end of September 2026. Reports that "Scout" was renamed "Autopilot" come from secondary blogs. — [Microsoft Partner Center Sept 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-september); [Dalikoo](https://dalikoo.com/microsoft-copilot-2026-home-code-autopilot/); [aguidetocloud Scout guide](https://www.aguidetocloud.com/blog/microsoft-scout-complete-guide/)
- Facilitator (Teams) takes meeting notes, manages tasks and creates documents in meetings (see Q1). — [M365 Admin MC1155927](https://m365admin.handsontek.net/facilitator-agent-generally-available-teams-meetings/)
- Agent Builder: agents can be submitted for admin review and published under "Built by your org" in the Agent Store (Build 2026). Copilot Studio is changing the build order so makers pick the target application first. — [ESPC Build 2026](https://espc.tech/learning-hub/blog/microsoft-build-2026-announcements/); [aguidetocloud Build recap](https://www.aguidetocloud.com/blog/microsoft-build-2026-recap/)
- Ignite 2025 tooling: "Copilot Studio, App Builder, Workflows — low-code/no-code tooling to build, train and deploy agents and lightweight apps with natural-language prompts." This comes from a forum summary, not an official source. — [WindowsForum Ignite 2025](https://windowsforum.com/threads/ignite-2025-copilot-becomes-an-agentic-platform-with-work-iq-and-agent-365.390199/)

### Inferences
- For "analyze reports and emails," the relevant agents today are Agent Mode in Excel and Word, Analyst for datasets, Researcher for multi-source synthesis across mail, files and web, and Cowork for longer multi-step jobs. Cowork has per-use credit costs on top of the seat license.
- Autopilot/Scout is the clearest signal of where Microsoft is heading: always-on agents with their own identity. It is not production-ready for a mid-size firm in 2026.

### Gaps
- Could not verify current status or descriptions of dedicated "Project Manager," "Surveys" or "Workflows" agents. The searches returned no primary-source description.
- Could not confirm whether the 25 queries/month cap on Researcher and Analyst still applies in 2026.
- Copilot Cowork's origins were not verified. A March 2026 preview reportedly built in collaboration with Anthropic is from memory only and is unsourced.

## 3. What memory, personalization and proactive features exist (acting without being asked, scheduled prompts, notifications)?

### Takeaway
Personalization runs through Work IQ (announced Ignite 2025). It draws on emails, files, meetings, chats, memory and usage patterns. Proactive features today are scheduled prompts (GA early 2026), Agent Builder scheduled workflows (rolling out from May 2026), Outlook agentic triage (preview), and Teams AI meeting memory files (GA planned December 2026). Fully autonomous "acting without being asked" is Autopilot/Scout, which is in private preview.

### Cited Findings
- Work IQ is "the intelligence layer behind Microsoft 365 Copilot and agents that helps Copilot understand you, your job, and your company." It combines work data (emails, files, meetings, chats), individual habits and preferences, and "memory and usage patterns." — [Microsoft Copilot blog, Ignite 2025](https://www.microsoft.com/en-us/copilot/blog/2025/11/18/microsoft-ignite-2025-copilot-and-agents-built-to-power-the-frontier-firm/); [Arvato Systems](https://us.arvato-systems.com/blog/microsoft-ignite-2025-copilot-ai-shape-the-workplace)
- Build 2026 introduced "Microsoft IQ" as a new context layer for Copilot and agents. — [ESPC Build 2026](https://espc.tech/learning-hub/blog/microsoft-build-2026-announcements/)
- Scheduled prompts turn a Copilot prompt into a recurring run, with results posted to Copilot conversation history in Teams, Outlook or web chat. The limit is 10 per user. The feature requires a Microsoft 365 Copilot license and "Optional connected experiences." Targeted release began late September 2025, GA began late January 2026, and completion was expected mid-February 2026. It is powered by the Workflows app in Teams on Power Platform, and a fixed DLP policy blocks most connectors. — [WindowsForum](https://windowsforum.com/threads/scheduled-copilot-prompts-in-microsoft-365-proactive-automation-for-teams.401490/); [WindowsForum, Workflows](https://windowsforum.com/news/microsoft-ai-workflows-scheduled-copilot-prompts-for-teams.401524/)
- Agent Builder scheduled workflows: worldwide rollout in May 2026. Users can create, edit, disable or delete scheduled workflows for their agents. — [M365 Admin (handsontek)](https://m365admin.handsontek.net/microsoft-365-copilot-schedule-prompts-agent-builder/)
- Outlook agentic Copilot (Frontier preview, 2026-04-27) proactively drafts follow-ups and resolves calendar conflicts. — [Thurrott](https://www.thurrott.com/cloud/335438/copilot-in-outlook-can-now-proactively-manage-your-inbox-and-calendar)
- Teams AI meeting memory files (MC1429018): targeted release early November 2026, GA early December 2026. — [mwpro.co.uk](https://mwpro.co.uk/blog/2026/10/13/mc1429018-microsoft-teams-adds-ai-meeting-memory-files-to-support-copilot-and-facilitator/)
- Autopilot/Scout takes "action on your behalf without waiting to be prompted" (private preview). — [Western Computer](https://www.westerncomputer.com/resources/blog/microsoft-scout-autopilot-agent)

### Inferences
- A business analyst can set up a daily or weekly scheduled prompt today, for example "summarize yesterday's exception emails and open items." Scheduled runs are limited to Microsoft first-party data, so they cannot reach the ERP through most connectors.

### Gaps
- No primary-source description was found of Copilot's user-facing "memory" feature (saved facts or custom instructions) and its 2026 status for enterprise users.
- No source was found on Copilot push notifications or proactive nudges beyond Outlook and Autopilot.

## 4. What computer use and browser automation exists, and can Copilot operate a third-party web ERP on a user's behalf today?

### Takeaway
Several computer-use paths exist. (1) Copilot Studio computer-using agents went GA in May 2026, with Microsoft-documented expectations of about 80% success on web tasks and about 35% on desktop. (2) Copilot Cowork browser use in Edge is admin-enabled, runs with the user's sign-ins, works only in an active browser session, and is not available for scheduled tasks. (3) Researcher with Computer Use runs in a sandboxed Windows 365 VM (Frontier preview since late 2025). (4) Edge's consumer "Browse with Copilot" (formerly Copilot Mode Actions) is limited to Microsoft 365 Premium in the US. (5) Windows Copilot Actions in an Agent Workspace is experimental. So Copilot can technically operate a third-party web ERP today, mainly via Cowork browser use or a Copilot Studio CUA, but reliability is far from deterministic and it needs admin enablement and governance.

### Cited Findings
**Copilot Studio computer use**
- Computer-using agents in Copilot Studio are GA and expanded to all commercial Power Platform geographies. Date: 2026-05-13 per Microsoft's changelog as cited by ChatForest and WindowsForum; other coverage says a May 26 update. — [Microsoft Copilot Studio blog](https://techcommunity.microsoft.com/blog/copilot-studio-blog/computer-using-agents-in-microsoft-copilot-studio-are-now-generally-available/4519427); [ChatForest](https://chatforest.com/reviews/microsoft-copilot-studio-computer-use-ga-enterprise-agents-may-2026/)
- They use vision and reasoning on live UIs rather than selectors. Reported expected success is about 80% for web tasks and about 35% for desktop applications, attributed to Microsoft documentation via secondary coverage. — [WindowsForum, 80% web / 35% desktop](https://windowsforum.com/news/copilot-studio-computer-use-80-web-35-desktop-success.444913/); [DevOps.com](https://devops.com/microsoft-copilot-studio-brings-computer-using-agents-to-the-enterprise/)
- GA governance includes session replay, DLP policies, Azure Key Vault credentials, and logs to Purview and Dataverse. Cost is reportedly 5 Copilot credits per agent action. — [Technspire](https://technspire.com/en/blog/computer-using-agents-hit-ga-when-copilot-studio-ui); [Aufait](https://aufaittechnologies.com/blog/securing-copilot-studio-computer-using-agents/)
- A commentator notes that an API call is "faster, more reliable, and more auditable" than vision-based UI interaction. — [Technspire](https://technspire.com/en/blog/computer-using-agents-hit-ga-when-copilot-studio-ui)

**Copilot Cowork browser use (Edge)**
- Off unless an admin enables the "Cowork Browsing" tenant setting. It works only when using Cowork in a browser, and is not supported in the desktop app or on mobile. — [Microsoft Learn, Use the local browser with Copilot Cowork](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-local-browser); [Microsoft Learn, Manage Copilot Cowork](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-admin-governance)
- It respects Edge allowlist, blocklist and view-only policies, and runs with the user's own sign-ins and access. It runs only while the browser session is active and does not work in scheduled or background tasks. — [Microsoft Learn, Cowork local browser](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-local-browser)
- A third-party guide says the Edge policy is "CopilotCoworkToolActionsEnabled" and that Cowork can act on websites that lack a plugin (unverified). — [msnugget](https://msnugget.com/copilot-cowork-browser-governance/); [powersolution.dev](https://powersolution.dev/posts/copilot-cowork-browser-use-edge/); [futurework.blog, 2026-08-28](https://futurework.blog/2026/08/28/copilot-cowork-browser-use-first-look/)

**Edge (consumer / M365 Premium)**
- 2026-05-13: Microsoft retired Copilot Mode in Edge and folded its features into standard Edge. Copilot Actions became "Browse with Copilot," limited to US Microsoft 365 Premium subscribers with usage limits. Journeys is broadly available on desktop and mobile. Multi-tab reasoning, Vision and Voice are in Edge. — [Microsoft Edge Blog, 2026-05-13](https://blogs.windows.com/msedgedev/2026/05/13/new-updates-to-edge-across-desktop-and-mobile/); [WindowsForum](https://windowsforum.com/threads/microsoft-retires-edge-copilot-mode-ai-browsing-features-move-into-edge.418221/)
- Browse with Copilot asks approval before acting on unfamiliar or less common sites. — [Microsoft Support, Browse with Copilot](https://support.microsoft.com/en-us/microsoft-copilot/browse-with-copilot)
- Edge for Business "agentic browsing": Copilot can act under IT rules. — [WindowsForum](https://windowsforum.com/threads/edge-for-business-agentic-browsing-copilot-can-act-under-it-rules.419324/)

**Researcher with Computer Use**
- Frontier preview, announced around November 2025. It runs in a secure Windows 365 VM with a visual browser, text browser, terminal and Microsoft Graph. Enterprise data access is disabled by default when Computer Use is on. Admins can scope it to pilot groups and set site allow and block lists. — [Neowin](https://www.neowin.net/news/microsoft-365-copilots-researcher-agent-can-now-take-action-with-computer-use/); [Futurum](https://futurumgroup.com/insights/microsoft-365-copilot-expands-researcher-agent-with-secure-computer-use/); [futurework.blog](https://futurework.blog/2025/11/04/researcher-agent-with-computer-use-in-microsoft-365-copilot/)

**Windows**
- Copilot Actions on Windows: began rolling out to Windows Insiders on 2025-11-17. It works on local files inside a separate, policy-controlled "Agent Workspace," is off by default, is preview-only, and runs under its own standard Windows account. — [Windows Insider Blog, 2025-11-17](https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/); [Microsoft Support, Experimental agentic features](https://support.microsoft.com/en-us/windows/ai/ai-features/experimental-agentic-features)

**Connectors as an alternative to UI automation**
- October 2026 roadmap: "federated connectors that can perform create, update, and delete actions in third-party systems." — [LevelUpM365, Oct 2026](https://levelupm365.com/2026/10/01/microsoft-365-roadmap-updates-october-2026/)

### Inferences
- For guiding users through a browser-based ERP, the most viable option today is Copilot Cowork browser use in Edge. It is GA as part of Cowork, needs admin enablement, uses the user's own session, and costs Copilot Credits. A Copilot Studio CUA suits repeatable back-office runs. An ~80% web success rate implies human review for any transactional ERP step. API or connector integration, where the ERP offers it, will be more reliable.
- Copilot does not appear to offer an in-ERP guided-tour or overlay for end users. Copilot Vision (screen sharing, release notes 2026-09-23) can explain what is on screen, which is the closest "guide me" capability.

### Gaps
- Could not verify current GA status of Researcher Computer Use, Windows Copilot Actions, or Browse with Copilot for commercial or Entra ID users as of October 2026.
- The 80%/35% reliability figures and the 5-credit-per-action cost are second-hand. The primary Microsoft Learn page could not be fetched.
- No independent benchmark was found of Copilot operating real third-party ERPs (SAP, NetSuite, Dynamics web UIs).

## 5. Which underlying models does Copilot use, and what is "model choice"?

### Takeaway
Copilot is multi-model. OpenAI GPT-5.x is the primary family, and OpenAI said in July 2026 that GPT-5.6 is the "preferred model" powering Word, Excel, PowerPoint, Chat and Cowork. Anthropic Claude models have been selectable since September 2025 (Researcher, Copilot Studio, later Excel and "Edit with Copilot") and are admin opt-in. Microsoft's own MAI models are mostly used behind "Auto" routing and in Word and Excel for cost reasons, per reporting. "Model choice" means a picker (Auto / GPT / Claude), and admins can restrict it.

### Cited Findings
- Claude was added on 2025-09-24: Claude Opus 4.1 in Researcher, and Claude Sonnet 4 plus Opus 4.1 in Copilot Studio. — [Claude blog](https://claude.com/blog/claude-now-available-in-microsoft-365-copilot); [Super Simple 365](https://supersimple365.com/anthropic-models-now-available-in-m365-copilot-researcher-and-copilot-studio/)
- Microsoft documentation: users can select Claude in Researcher and in "Edit with Copilot" in Microsoft 365 apps. In Copilot Studio, makers choose a model at agent creation. Admins enable Anthropic under "AI providers operating as Microsoft subprocessors." Anthropic models are hosted outside Microsoft-managed environments. — [Microsoft Learn, Anthropic models in Microsoft Online Services](https://learn.microsoft.com/en-us/microsoft-365/copilot/connect-to-ai-subprocessor)
- A third-party source says Anthropic models are excluded from EU Data Boundary and in-country processing commitments and disabled by default for EU tenants (verify). — [itechguides](https://www.itechguides.com/anthropics-claude-models-are-now-available-in-microsoft-365-copilot-what-that-means-in-2026/)
- Excel Agent Mode lets users choose between Anthropic and OpenAI models (Ignite 2025). — [Microsoft Ignite 2025 Book of News](https://news.microsoft.com/ignite-2025-book-of-news/)
- Claude was made available to Copilot Premium users at Ohio State as of April 2026. — [OSU IT](https://it.osu.edu/news/2026/04/01/anthropic-ai-models-available-copilot-premium-users)
- Newer Claude model names reported in the picker ("Claude Opus 4.7, Opus 4.8, preview Claude Fable 5") could not be verified against Microsoft's pages. — [itechguides](https://www.itechguides.com/anthropics-claude-models-are-now-available-in-microsoft-365-copilot-what-that-means-in-2026/) (flagged unverified)
- 2026-07-09: OpenAI said GPT-5.6 is the "preferred model" for Microsoft 365 Copilot and powers Word, Excel, PowerPoint, Copilot Chat and Cowork, "amid breakup chatter." Bloomberg reported Microsoft using in-house MAI models in Word and Excel to cut costs. — [TechCrunch, 2026-07-09](https://techcrunch.com/2026/07/09/openai-says-gpt-5-6-is-the-preferred-model-for-microsoft-copilot-amid-breakup-chatter/); [TUN](https://www.tun.com/home/openai-gpt-5-6-is-now-the-default-model-in-microsoft-365-copilot/)
- Microsoft published seven in-house MAI models on 2026-06-02, mostly on the developer side (GitHub Copilot, Azure Foundry) and behind "Auto" routing. In the mainstream picker the real choice is Claude vs. GPT, with Auto as a third option. Per documentation updated 2026-06-16, the picker shows Auto (default), Claude options and "GPT 5.5 (Frontier)." — [Sylvain Jacquemard blog, 2026-07-13](https://sylvainjacquemard.blog/2026/07/13/claude-gpt-mai-which-model-copilot-m365/); [Chris Menard Training](https://chrismenardtraining.com/post/microsoft-365-copilot-model-picker-changed-where-did-gpt-5-5-and-the-other-models-go/)
- Roadmap (April 2026): "multi-model reasoning (GPT + Claude)" and a "Researcher Council." — [LevelUpM365](https://levelupm365.com/2026/03/31/microsoft-365-roadmap-updates-april-2026/)
- Roadmap (October 2026): "Copilot local inferencing" for regional AI processing. — [LevelUpM365 Oct 2026](https://levelupm365.com/2026/10/01/microsoft-365-roadmap-updates-october-2026/)

### Inferences
- Model mix is volatile: picker names changed during 2026, and the Microsoft-OpenAI relationship is being renegotiated. Plans should not depend on a specific model being available. "Auto" routing is the stable default.
- Unlicensed or free users stay on the default model without choice (see Q1).

### Gaps
- No primary Microsoft statement was found on which model is default per surface as of October 2026.
- The MAI model names and capabilities used inside Copilot were not verified.

## 6. What is on the public roadmap for late 2026 through 2027, and what was announced at Ignite 2025, Build 2026 and fall 2026 events?

### Takeaway
Ignite 2025 (Nov 18, 2025) set up the agent platform: Work IQ, Agent 365 (preview), Word Agent Mode GA, Office agents in chat. Build 2026 (from June 2, 2026) brought Copilot Cowork GA, Microsoft Scout/Autopilot, Microsoft IQ and Agent 365 endpoint discovery. The 2026-09-25 "new Copilot" announcement merged the experience into Home / Code / Autopilot with usage-based pricing. Near-term roadmap items: Teams AI meeting memory (Nov–Dec 2026), Facilitator channel meetings, federated connectors with write actions, local inferencing, and Autopilot private preview expansion. Ignite 2026 is scheduled for Nov 17–20, 2026 in San Francisco. No 2027-specific roadmap was found.

### Cited Findings
- Ignite 2025: Work IQ; Agent 365 as the control plane for agents (public preview via Frontier); Word Agent Mode GA; Word, Excel and PowerPoint agents in chat; Excel Agent Mode web search and model choice. — [Microsoft Ignite 2025 Book of News](https://news.microsoft.com/ignite-2025-book-of-news/); [Microsoft Copilot blog, 2025-11-18](https://www.microsoft.com/en-us/copilot/blog/2025/11/18/microsoft-ignite-2025-copilot-and-agents-built-to-power-the-frontier-firm/)
- Build 2026: Copilot Cowork GA plus Microsoft Scout introduced, with usage-based pricing via Copilot Credits (Partner Center). Agent 365 now discovers AI agents on managed endpoints, first covering Claude Code and GitHub Copilot CLI. Agent Builder gets admin review and publishing to the Agent Store. Microsoft IQ is introduced. — [Microsoft Partner Center June 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-june); [Microsoft Build 2026 recap](https://developer.microsoft.com/blog/build-recap/); [aguidetocloud Build recap](https://www.aguidetocloud.com/blog/microsoft-build-2026-recap/); [ESPC](https://espc.tech/learning-hub/blog/microsoft-build-2026-announcements/)
- 2026-09-25 "new Copilot": Home (Chat + Cowork + Office), Code, and Autopilot. The September update also included Code, Autopilot and Managed Runtime capabilities plus Copilot Credits and FinOps controls. — [Microsoft Partner Center Sept 2026](https://learn.microsoft.com/en-us/partner-center/announcements/2026-september); [eGroup](https://egroup-us.com/news/copilot-september-2026-update/)
- October 2026 roadmap drops: Copilot local inferencing for regional AI processing; federated connectors with create, update and delete actions in third-party systems. — [LevelUpM365 Oct 2026](https://levelupm365.com/2026/10/01/microsoft-365-roadmap-updates-october-2026/)
- October 2026 Microsoft 365 updates coverage mentions "Copilot Billing, Home & More." — [ChangePilot](https://changepilot.cloud/blog/october-2026-microsoft-365-updates-copilot-billing-home-more)
- Teams AI meeting memory files: targeted release early November 2026, GA early December 2026. — [mwpro.co.uk MC1429018](https://mwpro.co.uk/blog/2026/10/13/mc1429018-microsoft-teams-adds-ai-meeting-memory-files-to-support-copilot-and-facilitator/)
- Ignite 2026: November 17–20, 2026, Moscone Center, San Francisco (third-party listings). — [CX Today](https://www.cxtoday.com/events/microsoft-ignite-2026/); [Navan](https://navan.com/blog/microsoft-ignite-guide)
- Dynamics 365 2026 release wave 1 covers April–September 2026. — [Microsoft Learn Dynamics 365 2026 wave 1](https://learn.microsoft.com/en-us/dynamics365/release-plan/2026wave1/)

### Inferences
- Expect Ignite 2026 (Nov 17–20) to move Autopilot and Cowork browser features toward broader availability and to detail 2027 pricing and SKUs. This is speculation based on the pattern, not an announcement.
- Federated connectors with write actions are the roadmap item most relevant to an ERP use case. They would let Copilot act on ERP data via connectors instead of screen automation.

### Gaps
- No public 2027 Copilot roadmap items were found. The Microsoft 365 Roadmap site could not be fetched.
- Release dates for Federated connector write actions and local inferencing were not retrieved.
- Mid-September 2026 cancellations of roadmap items were mentioned but not itemized.

## 7. Pricing and licensing (M365 Copilot price, Copilot Business, E5/E7 bundles, consumption pricing)

### Takeaway
The Microsoft 365 Copilot enterprise seat remains $30/user/month. Copilot Business for SMBs (up to 300 seats) launched at $21/user/month, announced 2025-12-02. Microsoft 365 E7 "Frontier Suite" lists at about $99/user/month and bundles E5, Copilot, Entra Suite and Agent 365 (GA reportedly 2026-05-01). Agentic work (Cowork, Code, Managed Runtime, Copilot Studio computer use) is billed on top in Copilot Credits at $0.01/credit PayGo, or discounted via prepaid P3 commitments.

### Cited Findings
- The Copilot Cowork task bill is in Copilot Credits on top of the $30 Copilot license. PayGo is $0.01 per Copilot Credit, and P3 is a pre-committed volume at a discount. Admins see usage by user, group and feature. Cowork is disabled by default and requires admin-set spending limits. — [Microsoft Copilot blog, 2026-06-16](https://www.microsoft.com/en-us/copilot/blog/2026/06/16/copilot-cowork-is-now-generally-available/); [Quisitive](https://quisitive.com/copilot-cowork-pricing-2026-how-usage-based-billing-works/)
- Third-party per-task estimates: light tasks $0.70–$2, heavy multi-output tasks $15 or more (not Microsoft figures). A $0.008 prepaid credit rate was cited but not confirmed. A claim that admins had to configure billing before July 1 was not confirmed. — [Avantiico](https://avantiico.com/copilot-cowork-pricing-for-businesses-guide/); [TMC](https://abouttmc.com/blog/copilot-cowork-pricing/); [cowork.tips](https://www.cowork.tips/blog/copilot-cowork-pricing-explained)
- The September 2026 update extends usage-based pricing and FinOps controls to Cowork, Code and Managed Runtime. — [eGroup](https://egroup-us.com/news/copilot-september-2026-update/)
- Copilot Studio CUA costs a reported 5 credits per agent action. — [Technspire](https://technspire.com/en/blog/computer-using-agents-hit-ga-when-copilot-studio-ui)
- Copilot Business: $21/user/month on annual commitment, up to 300 seats, launch confirmed by Microsoft on 2025-12-02. Promo rate was $18, with end dates reported as June 30 or Sept 30, 2026 (conflict). Reported bundles: Business Standard + Copilot at about $23.50 and Business Premium + Copilot at $32. — [Microsoft Copilot blog, 2025-12-02](https://www.microsoft.com/en-us/copilot/blog/2025/12/02/microsoft-365-copilot-business-the-future-of-work-for-small-businesses/); [SoftwareOne](https://www.softwareone.com/en-us/channel-partner/articles/2026/05/26/lower-copilot-prices-bigger-partner-opportunity); [HBS](https://www.hbs.net/blog/microsoft-365-copilot-business-smb)
- Microsoft 365 E7 "Frontier Suite": $99/user/month list, GA 2026-05-01 per resellers. It bundles E5 + Copilot + Entra Suite + Agent 365 (about $117 if bought separately). Promotional CSP pricing through 2026-12-31 brings it to about $84. Sources conflict on the E5 component price ($57 vs. $60 after July 2026). — [No Jitter](https://www.nojitter.com/ai-automation/microsoft-e7-license-introduces-new-pricing-approach); [SAMexpert](https://samexpert.com/microsoft-365-e7-licensing-guide/); [Red River](https://redriver.com/technology-solutions/microsoft-365-e7-license-and-upgrade)
- Free Copilot Chat paywall for in-app use at tenants above 2,000 seats from 2026-04-15 (see Q1). — [SAMexpert](https://samexpert.com/copilot-chat-enterprise-restriction-april-2026/)
- Earlier change: unlicensed Copilot Chat users have faced a daily image-generation limit since late April 2025. — [Purdue IT](https://it.purdue.edu/newsroom/articles/260403-microsoft-removes-in-app-copilot-chat-features-for-non-licensesd-users.php)

### Inferences
- A mid-size firm's real Copilot cost is now seat plus consumption. Budgeting for agentic ERP or browser work and Cowork tasks needs a credit forecast and admin spending caps. If the company has 300 seats or fewer, Copilot Business at $21 is likely the cheaper seat.

### Gaps
- Pricing and seat caps were not verified against Microsoft's current pricing page, which could not be fetched. Most figures come from resellers.
- No information was found on whether Autopilot/Scout will carry separate pricing.
- No confirmation was found of any 2027 list-price changes for Copilot.
