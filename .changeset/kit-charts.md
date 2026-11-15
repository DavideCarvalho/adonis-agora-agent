---
'@adonis-agora/agent-dashboard': patch
---

Charts now show a tooltip with the value when you hover or focus them: the usage trend (Overview and Generative UI: cost in USD or tokens per day), Reliability's runs vs failed bars, and the donuts (spend by model, run outcomes, failures by code: name, value and share per slice). They are built on the console kit's TanStack Charts components and follow the light/dark theme. The console kit gains charts on TanStack Charts (`agora-kit/charts`: TimeSeriesChart, BarChart, Sparkline, DonutChart) with a themed tooltip on hover and keyboard focus.
