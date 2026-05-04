1. On Error of sharing the same page/context

```
Why AegntQL error currently affects LiveURL:

login:agentql:reuse-live runs one shared browser/page pipeline.
AgentQL operates on that same page/context.
If AgentQL throws while the page/context is unstable/closed, the run exits and finally closes browser, which kills LiveURL.
```
