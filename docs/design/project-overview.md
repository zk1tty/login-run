# StayAuthed Project Overview

## Core Motivation

StayAuthed exists because agents need authenticated access to non-API platforms.

Many useful workflows happen inside websites, portals, dashboards, and legacy systems that do not expose clean APIs. If an agent needs to operate there, the user must first prove account ownership through a real browser login flow. That login may include CAPTCHA, proxy-sensitive bot checks, OTP, SSO, device recognition, or other interactive steps.

The goal is to let the user complete login once, then keep a remote browser session authenticated so agents can reconnect and run workflows repeatedly without bothering the user again and again.

## Problem

The hard part is not just "build an agent."

The hard part is the infrastructure around the agent:

- forwarding user credentials or interactive login into a remote browser
- handling CAPTCHA, proxy, and browser fingerprint constraints
- preserving session state after the first successful login
- letting different agents reconnect to the same authenticated browser context
- giving users a way to observe or intervene when needed
- avoiding lock-in to one browser-agent provider

Most teams need this layer, but they usually rebuild it from scratch.

## Why Existing Agent Providers Are Not Enough

Browser-agent providers are useful, but login/session management is still uneven:

- CAPTCHA and proxy behavior are provider-specific and often incomplete.
- Quick tests require too much environment setup.
- Enterprise support is expensive and slow for smaller builders.
- Providers tend to bundle agent logic with browser infrastructure, which creates lock-in.

StayAuthed focuses on the shared infrastructure layer so agent implementation can remain flexible.

## Solution Shape

StayAuthed provides:

1. Credential forwarding into a remote browser login flow.
2. Session persistence after successful authentication.
3. Reconnectable browser sessions for repeat agent workflows.
4. Observable async run state through polling and SSE.
5. A path toward cloud sandbox code-mode workflows, where natural-language requests generate and run browser workflow code on demand.

## Current Implementation

The current server is a Puppeteer-only login API backed by Browserless Session API sessions.

It exposes:

```text
POST /v1/logins
GET  /v1/logins/:runId
GET  /v1/logins/:runId/events
POST /v1/logins/:runId/otp
```

The login engine uses deterministic page inventory, stage classification, action planning, and browser action execution rather than prompt-driven browser control.

## Product Principle

StayAuthed should stay infrastructure-first:

- keep user authentication/session management separate from agent logic
- expose a small API that frontend and agent runtimes can integrate quickly
- preserve provider choice for the browser/agent layer
- make failure states observable and debuggable
- keep README short and move deeper design/research into focused docs
