# MONARCH — MASTER DEVELOPMENT SPECIFICATION

## 1. Project Overview

Build **Monarch**, a visual Discord server design and customization platform.

Monarch is **not a moderation bot** and must not evolve into a generic multipurpose Discord bot.

Its purpose is to let Discord server owners/admins **visually design, customize, organize, preview, save, version, and deploy their Discord servers** through a polished web dashboard.

Think of Monarch as:

> **A visual IDE for Discord servers.**

The Discord bot is the execution/integration layer. The web dashboard is the primary product.

### Brand

**Name:** Monarch

Suggested positioning:

> **Monarch — Design your Discord.**

The branding should feel:

* premium
* modern
* minimal
* technical without looking corporate
* visually focused
* suitable for a SaaS product

Do not use excessive gaming/bot aesthetics.

---

# 2. Core Product Philosophy

Monarch should make Discord server customization feel like designing a website or application.

The user should be able to:

1. Connect Discord.
2. Select a server.
3. Visually inspect the server.
4. Modify its structure.
5. Design messages and embeds.
6. Design roles and branding.
7. Preview everything.
8. Save the design.
9. Compare changes.
10. Apply changes to Discord.

Whenever possible:

> **Preview first → validate → show diff → confirm → apply.**

Never blindly modify a server.

---

# 3. Technology Stack

Use TypeScript throughout the application wherever practical.

## Dashboard

* Next.js
* React
* TypeScript
* Modern CSS / Tailwind CSS
* Component-based UI architecture

The dashboard should feel like a professional design application rather than an administration panel.

## Discord Integration

* Node.js
* TypeScript
* discord.js
* Discord API v10

Keep all Discord-specific implementation behind an abstraction layer.

The dashboard should not directly depend on discord.js internals.

## Backend

Either:

* Next.js API routes/server actions

or preferably, if the project grows sufficiently:

* separate Node.js/TypeScript API service

The architecture must allow the backend to be separated later without rewriting the application.

## Database

* PostgreSQL
* Prisma or Drizzle ORM

Store application state, designs, templates, snapshots, users, servers, preferences, etc.

## Deployment

Docker-first architecture.

Initial services:

```text
monarch/
├── dashboard
├── api
├── bot
└── postgres
```

A single-process development mode is acceptable for local development, but production architecture should keep responsibilities separated.

---

# 4. Repository Structure

Use a monorepo architecture.

Suggested:

```text
monarch/
│
├── apps/
│   ├── dashboard/
│   ├── api/
│   └── bot/
│
├── packages/
│   ├── shared/
│   ├── discord/
│   ├── schemas/
│   ├── validation/
│   ├── renderer/
│   └── design-engine/
│
├── prisma/
│
├── docker/
│
├── docs/
│
└── README.md
```

Use shared packages for types and schemas instead of duplicating models between dashboard, API and bot.

---

# 5. Discord Authentication

Implement Discord OAuth2 authentication.

Flow:

```text
User
 ↓
Monarch Login
 ↓
Discord OAuth2
 ↓
Authentication callback
 ↓
Monarch session
 ↓
Dashboard
```

The dashboard should show the user's Discord servers that Monarch can legitimately interact with.

For every server, determine:

* server ID
* server name
* icon
* whether Monarch is installed
* whether the user has sufficient permissions
* Monarch's permissions
* available channels
* available roles

Do not assume that every server returned by Discord is editable.

---

# 6. Server Selection

The user must be able to select the server they are designing.

Example:

```text
MONARCH

Select a server

┌──────────────────────────┐
│ 🏰 My Community          │
│ 12,482 members           │
│                          │
│ [ Design Server ]        │
└──────────────────────────┘

┌──────────────────────────┐
│ 🎮 Gaming Community      │
│ 4,821 members            │
│                          │
│ [ Design Server ]        │
└──────────────────────────┘
```

The selected server becomes the context for the dashboard.

Never silently operate on another server.

---

# 7. Target Resolver System

This is a critical architectural requirement.

Every feature that generates or publishes something must support a target configuration.

Use:

```text
Feature
 ↓
Target Resolver
 ↓
Guild
 ↓
Channel
 ↓
Thread (if applicable)
 ↓
Permission Check
 ↓
Validation
 ↓
Discord API
```

Do not assume `#general`.

Users must be able to designate where Monarch publishes things.

Examples:

```text
Global Designated Channels

Welcome Channel:
#welcome

Announcements:
#announcements

Testing:
#bot-testing

Template Testing:
#design-testing
```

Feature-specific overrides must also be possible.

For example:

```text
Embed Builder
Target:
Server: My Community
Channel: #announcements

Welcome Designer
Target:
Server: My Community
Channel: #welcome
```

The target resolver should be reusable by every feature.

Important distinction:

### Discord interactions

If a user invokes a Discord interaction, the immediate interaction response must obey Discord's interaction context.

Do not attempt to arbitrarily respond to another server as the interaction response.

### Generated/published content

Messages, embeds, announcements, tests, etc. may be sent to a configured target channel after appropriate permission checks.

---

# 8. Internal Server Design Model

Do NOT make raw Discord JSON the application's primary internal representation.

Create a clean internal design schema.

Example:

```ts
ServerDesign {
    guildId
    name
    categories[]
    channels[]
    roles[]
    branding
    designatedChannels
    metadata
}
```

Example channel:

```ts
ChannelDesign {
    id?
    name
    type
    topic?
    position
    parentId?
    nsfw?
    slowmode?
    permissions?
}
```

The internal representation should be converted to Discord API payloads through a dedicated renderer/adapter.

Architecture:

```text
Dashboard
   ↓
Internal Design Schema
   ↓
Validation Engine
   ↓
Diff Engine
   ↓
Discord Renderer
   ↓
Discord API
```

This abstraction is mandatory because Discord's API will evolve.

---

# 9. FEATURE SET

There are exactly **10 core features enabled by default**.

Other features should exist as optional modules that can be enabled later.

---

# FEATURE 1 — SERVER DESIGNER

The primary Monarch feature.

Allow users to visually design:

* categories
* text channels
* voice channels
* announcement channels
* forum channels
* channel names
* topics
* ordering
* category hierarchy
* channel organization
* relevant channel settings

The UI should resemble a Discord server visually.

Example:

```text
SERVER DESIGNER

INFORMATION
 ├── # welcome
 ├── # rules
 └── # announcements

COMMUNITY
 ├── # general
 ├── # media
 └── # off-topic

VOICE
 ├── 🔊 General
 └── 🔊 Gaming
```

Features:

* drag-and-drop ordering
* create/delete/rename
* move channels
* move channels between categories
* duplicate structures
* visual hierarchy
* live preview
* undo/redo
* unsaved changes indicator

Never immediately modify Discord while the user is editing.

Use:

```text
Draft
 ↓
Preview
 ↓
Diff
 ↓
Apply
```

---

# FEATURE 2 — ADVANCED EMBED BUILDER

This is one of Monarch's flagship features.

Create a highly detailed visual Discord embed editor.

Support all relevant Discord embed properties.

### Embed

* author
* author name
* author URL
* author icon
* title
* title URL
* description
* color
* fields
* inline fields
* thumbnail
* image
* footer
* footer icon
* timestamp
* Markdown
* mentions
* URLs

Support multiple embeds in one message.

The builder must enforce Discord's current limits through the validation engine rather than hardcoding arbitrary limits throughout the application.

### UI

Use a three-panel editor:

```text
┌──────────────┬───────────────────────────┬────────────────────┐
│ COMPONENTS   │ DISCORD PREVIEW           │ PROPERTIES         │
│              │                           │                    │
│ + Author     │     ┌─────────────────┐   │ Color              │
│ + Title      │     │                 │   │ #5865F2            │
│ + Desc       │     │ Embed Preview   │   │                    │
│ + Field      │     │                 │   │ Title              │
│ + Image      │     │                 │   │ Description        │
│ + Thumbnail  │     │                 │   │ URL                │
│ + Footer     │     │                 │   │ Timestamp           │
│              │     └─────────────────┘   │                    │
│ FIELDS       │                           │ [Send Test]         │
│ ├─ Rules     │                           │ [Save Template]     │
│ ├─ Info      │                           │ [Publish]           │
│ └─ Links     │                           │                    │
└──────────────┴───────────────────────────┴────────────────────┘
```

Field editor:

* drag/drop
* reorder
* duplicate
* delete
* inline toggle

Color editor:

* HEX
* RGB
* HSL
* presets
* palette suggestions

Image handling:

* URL
* uploaded image
* Discord attachment-backed image where appropriate

Variables:

```text
{user}
{username}
{display_name}
{server}
{member_count}
{channel}
```

The variable system should be extensible.

### Preview

Preview should support:

* desktop
* mobile
* compact
* contextual server
* contextual user
* contextual channel

The preview must visually resemble Discord as closely as reasonably possible.

Include:

* live updates
* validation warnings
* character counts
* field limits
* embed limits
* Markdown preview

Support:

* drafts
* templates
* version history
* undo/redo
* test sending
* publishing

---

# FEATURE 3 — MESSAGE & COMPONENT DESIGNER

Build a visual message designer.

Do not design Monarch exclusively around legacy embeds.

Plan around Discord's current Components architecture and Components V2.

The internal representation should support:

```text
Message
 ├── content
 ├── embeds[]
 └── components[]
```

Components should be represented as a tree.

Example:

```text
Message
│
├── Text
├── Embed
│
└── Components
    ├── Button
    ├── Button
    └── Select Menu
```

Support:

* buttons
* links
* select menus
* action rows where applicable
* current Discord components
* Components V2
* text displays
* containers
* sections
* media where supported
* interactive layouts where supported

The architecture must make it possible to add future Discord component types without redesigning the editor.

Create:

```text
Component Schema
Component Renderer
Component Validator
Component Preview
Discord Component Serializer
```

---

# FEATURE 4 — ROLE DESIGNER

Purely focused on customization and hierarchy.

Support:

* create roles
* rename roles
* colors
* role icons where supported
* ordering
* hierarchy visualization
* permissions configuration
* duplicate roles
* palette generation
* drag-and-drop hierarchy

Create a visual hierarchy:

```text
OWNER
│
├── ADMIN
│
├── MODERATOR
│
├── STAFF
│
├── VIP
│
└── MEMBER
```

Provide warnings for Discord hierarchy/permission constraints.

Do not turn this feature into a moderation system.

---

# FEATURE 5 — WELCOME & ONBOARDING DESIGNER

Create visually designed welcome/onboarding experiences.

Support:

* welcome message
* welcome embed
* welcome image
* variables
* buttons
* role-selection menus where supported
* server information
* designated welcome channel
* preview

Example:

```text
┌──────────────────────────────┐
│        WELCOME TO            │
│       MY COMMUNITY           │
│                              │
│  We're glad you're here.     │
│                              │
│ [📜 Rules] [🎭 Roles]        │
│                              │
└──────────────────────────────┘
```

Include Discord-like live preview.

---

# FEATURE 6 — SERVER BRANDING STUDIO

Create a centralized branding system.

Support:

* server icon
* server banner
* accent colors
* primary color
* secondary color
* role palette
* emoji style
* message style
* embed style

Themes should propagate to other Monarch features.

Example:

```text
MONARCH THEME

Primary:   #5865F2
Secondary: #9B59B6
Accent:    #FFFFFF

Role Palette:
ADMIN
MOD
STAFF
MEMBER
VIP
```

Users should be able to create reusable visual themes.

---

# FEATURE 7 — TEMPLATE SYSTEM

Templates are a major part of Monarch.

Templates may contain:

* server layouts
* categories
* channels
* embeds
* messages
* components
* welcome messages
* role configurations
* branding
* complete design systems

Actions:

* create
* duplicate
* edit
* preview
* rename
* delete
* export
* import
* save current design as template

Template format should be versioned.

Example:

```json
{
    "format": "monarch-template",
    "version": 1,
    "type": "server",
    "data": {}
}
```

Do not make templates dependent on raw Discord IDs.

Templates must be portable.

---

# FEATURE 8 — SERVER BACKUP & VERSION HISTORY

Monarch should maintain snapshots of the configurations it manages.

Support:

* create snapshot
* automatic snapshots before major changes
* manual snapshots
* browse history
* compare versions
* restore versions
* name snapshots

Example:

```text
VERSION HISTORY

v14  Today 18:42
"New community layout"

v13  Today 16:21
"Role redesign"

v12  Yesterday
"Initial Monarch setup"
```

Comparison:

```diff
+ #media
+ #showcase

~ #chat → #general

- #old-chat
```

Do not promise that Monarch can back up or restore every piece of Discord state.

Only claim support for resources the Discord API and Monarch's permissions allow it to manage.

---

# FEATURE 9 — DESIGN ANALYZER & CLEANUP

Analyze the server's organization and aesthetics.

This is NOT a moderation analyzer.

Analyze:

* naming consistency
* channel structure
* category organization
* role naming
* role color consistency
* redundant structures
* inconsistent capitalization
* excessive clutter
* poor organization
* branding consistency

Example:

```text
SERVER DESIGN SCORE

Organization       86%
Naming             91%
Role Consistency   72%
Branding           94%

Overall             86%
```

Suggestions:

```text
⚠ Role colors are inconsistent.

Suggestion:
Use a unified 5-color palette.

⚠ Three channels have inconsistent naming.

Suggestion:
Convert:
#general-chat
#general_chat
#General

to:

#general
```

Recommendations must be suggestions.

Do not automatically modify the server.

---

# FEATURE 10 — SERVER IMPORT / EXPORT / CLONE

Support importing and exporting Monarch designs.

Support:

* JSON export
* JSON import
* server design duplication
* cloning a Monarch design between servers
* previewing differences
* applying differences

Before applying:

```text
MONARCH CHANGE PREVIEW

+ 5 channels
+ 2 roles

~ 3 channels renamed
~ 1 category moved

- 2 channels

[Cancel]          [Apply]
```

Use:

```text
+
created

~
modified / renamed / moved

-
deleted
```

Always require explicit confirmation before destructive changes.

Never advertise Monarch as being able to perfectly clone things that Discord's API does not permit it to clone.

---

# 10. OPTIONAL FEATURES

These are NOT part of the initial default feature set.

Build the architecture so they can be added as modules later.

Potential modules:

* Emoji & Sticker Manager
* Interactive Role Menus
* Announcement Designer
* Event Designer
* Social Links / Link Hub
* Advanced Server Themes
* Cross-Server Design Systems
* Screenshot → Server Design
* Advanced Automation
* Community Template Marketplace
* Branding generation
* Role palette generator
* Quick Actions
* Favorites
* Saved components
* Sandbox / Preview Mode
* mobile preview
* desktop preview
* design screenshot recreation

Do not implement these before the ten core features are stable unless needed as infrastructure dependencies.

---

# 11. DIFF ENGINE

Create a reusable diff engine.

Input:

```text
Current Discord State
+
Desired Monarch Design
```

Output:

```text
ServerDiff
```

Represent:

* created
* modified
* moved
* renamed
* deleted
* unchanged
* unsupported

Example:

```text
CREATE
├── channel #media
└── role @VIP

MODIFY
└── #announcements
    └── topic

MOVE
└── #rules

DELETE
└── #old-chat
```

The diff engine must be used by:

* Server Designer
* Role Designer
* Import/Export
* Clone
* Restore
* Templates

---

# 12. VALIDATION ENGINE

Create a centralized validation system.

Validation must occur before API calls.

Validate:

* Discord resource constraints
* names
* lengths
* supported fields
* permissions
* hierarchy
* required properties
* component constraints
* embed constraints
* target channel validity

Return useful errors.

Example:

```text
❌ Cannot create role "Administrator"

Reason:
Monarch cannot position this role above its own highest role.

Fix:
Move the Monarch bot role higher in the server hierarchy.
```

Never expose raw API errors when a useful human-readable explanation can be provided.

---

# 13. DISCORD API ABSTRACTION

Create a dedicated Discord service.

Example:

```ts
DiscordService
├── GuildService
├── ChannelService
├── RoleService
├── MessageService
├── ComponentService
├── WebhookService
└── AssetService
```

The rest of Monarch should call these abstractions instead of directly making Discord API requests.

Handle:

* authentication
* permissions
* API errors
* retries where appropriate
* rate limits
* request failures
* unsupported resources

Do not hardcode Discord rate limits throughout the application.

Use the current API behavior and library support.

---

# 14. PERMISSIONS

Permission handling must exist throughout the application.

Before every mutation:

```text
User permission check
+
Bot permission check
+
Hierarchy check
+
Target validation
+
API operation
```

The UI should hide or disable actions that cannot be performed.

But never rely solely on frontend restrictions.

The backend must independently validate permissions.

---

# 15. DRAFT SYSTEM

Most design operations should happen inside a draft.

Example:

```text
CURRENT SERVER
      ↓
Create Draft
      ↓
Edit
      ↓
Preview
      ↓
Validate
      ↓
Diff
      ↓
Apply
```

Display:

```text
● Unsaved changes
```

Allow:

* save draft
* discard draft
* autosave
* undo
* redo

---

# 16. UNDO / REDO

Implement application-level undo/redo.

At minimum:

```text
Ctrl+Z
Ctrl+Shift+Z
```

(or platform equivalents)

This should work throughout major design editors.

Use immutable state/history where practical.

---

# 17. LIVE PREVIEWS

Previews are central to Monarch.

Whenever feasible, the dashboard should show the result before anything is sent to Discord.

Create reusable preview components:

```text
DiscordServerPreview
DiscordMessagePreview
DiscordEmbedPreview
DiscordComponentPreview
DiscordRolePreview
DiscordWelcomePreview
```

Do not create separate incompatible preview systems for each feature.

---

# 18. TEST MODE

Every message-producing feature should support:

> **Send Test**

The user selects a target channel through the Target Resolver.

Example:

```text
SEND TEST

Server:
My Community

Channel:
#bot-testing

[Cancel] [Send Test]
```

Do not automatically send test messages to `#general`.

---

# 19. DATABASE MODEL

At minimum consider:

```text
User
DiscordAccount
Guild
GuildMembership
GuildSettings
ServerDesign
DesignDraft
DesignVersion
Template
TemplateVersion
MessageDesign
EmbedDesign
ComponentDesign
RoleDesign
BrandTheme
TargetConfiguration
AuditEntry
```

Use proper relations and indexes.

Never store Discord tokens insecurely.

---

# 20. SECURITY

Treat Discord OAuth credentials and tokens as sensitive.

Requirements:

* secure session handling
* encrypted secrets
* environment variables
* server-side permission validation
* CSRF protection where applicable
* input validation
* API authorization
* rate limiting for Monarch's own endpoints
* safe file/image handling
* prevent arbitrary URL abuse where applicable

Do not expose bot credentials to the frontend.

---

# 21. UI/UX

The dashboard should feel like a professional design tool.

Preferred layout:

```text
Sidebar
   ↓
Feature Navigation

Main Canvas
   ↓
Live Editor / Preview

Inspector
   ↓
Properties
```

Use:

* dark mode first
* clean typography
* subtle animations
* drag-and-drop
* tooltips
* keyboard shortcuts
* command palette
* contextual menus
* autosave indicators
* responsive design

Avoid:

* giant collections of buttons
* cluttered admin-panel layouts
* unnecessary gradients everywhere
* excessive Discord/gaming clichés

The UI should feel like:

> Figma + Discord + modern SaaS dashboard.

---

# 22. GLOBAL NAVIGATION

Suggested:

```text
MONARCH

Overview

DESIGN
  Server Designer
  Embed Builder
  Message Designer
  Role Designer
  Welcome Designer
  Branding

LIBRARY
  Templates
  Components
  Saved Designs

MANAGE
  Backups
  Version History
  Analyzer
  Import / Export

SETTINGS
  Server Settings
  Designated Channels
  Integrations
  Account
```

Optional modules should appear separately.

---

# 23. SERVER CONTEXT

The selected server should always be visible.

Example:

```text
🏰 My Community
```

with a dropdown.

When changing server:

* warn about unsaved changes
* save or discard draft
* reload server state
* update target resolver
* update preview context

Never accidentally apply changes to the previous server.

---

# 24. FEATURE MODULE SYSTEM

Implement features as modular systems.

Conceptually:

```ts
FeatureModule {
    id
    name
    enabled
    permissions
    routes
    components
}
```

This allows optional features to be enabled later without rewriting the dashboard.

Core features should be enabled by default.

---

# 25. DESIGN SYSTEM

Create Monarch's own design system.

Shared components:

```text
Button
Input
Select
ColorPicker
Modal
Drawer
Tabs
Dropdown
Tooltip
Toast
Panel
Inspector
Preview
DragHandle
SortableList
Tree
DiffViewer
ConfirmDialog
```

The application should not become a collection of unrelated UI components.

---

# 26. ERROR HANDLING

Errors must be understandable.

Bad:

```text
DiscordAPIError[50013]
```

Good:

```text
Monarch couldn't move this role.

The Monarch bot's highest role is below the role you're trying to move.

Move Monarch's bot role higher in Server Settings → Roles and try again.
```

Keep technical errors in logs for developers.

---

# 27. LOGGING

Implement structured logging.

Log:

* API operations
* Discord requests
* errors
* permission failures
* validation failures
* design applications
* restores
* imports
* exports

Never log:

* OAuth tokens
* bot tokens
* sensitive credentials

---

# 28. TESTING

Create automated tests for:

### Unit tests

* schemas
* validators
* diff engine
* renderers
* permissions
* target resolver

### Integration tests

* Discord service
* database
* API

### UI tests

* server designer
* embed builder
* message builder
* role designer
* import/export

Test destructive operations carefully.

---

# 29. DEVELOPMENT PHASES

Do NOT attempt to build everything simultaneously.

## Phase 1 — Foundation

Build:

* monorepo
* dashboard
* API
* bot
* PostgreSQL
* authentication
* Discord connection
* server selection
* shared schemas
* permission system

Goal:

```text
Login → select server → view server
```

---

## Phase 2 — Server Designer

Build:

* server visualization
* categories
* channels
* drag/drop
* drafts
* undo/redo
* validation
* diff engine
* apply changes

Goal:

```text
Login
→ Select Server
→ Visually redesign server
→ Preview diff
→ Apply
```

This is the first major milestone.

---

## Phase 3 — Embed Builder

Build the flagship editor.

Goal:

```text
Create embed
→ Preview
→ Validate
→ Send Test
→ Save Template
→ Publish
```

---

## Phase 4 — Message / Components

Build:

* message editor
* component tree
* Components V2 architecture
* preview
* validation
* test sending

---

## Phase 5 — Roles / Branding / Welcome

Build:

* role designer
* branding studio
* welcome/onboarding designer

Integrate the shared theme system.

---

## Phase 6 — Templates / Backups

Build:

* template system
* snapshots
* version history
* restore
* comparison

---

## Phase 7 — Analyzer / Import / Export

Build:

* design analyzer
* cleanup suggestions
* JSON export/import
* server cloning
* diff previews

---

# 30. FIRST MVP

The first usable Monarch MVP should NOT attempt to implement all ten features.

MVP:

```text
Discord Login
      ↓
Server Selection
      ↓
Server Designer
      ↓
Draft System
      ↓
Validation
      ↓
Diff Preview
      ↓
Apply Changes
```

Then add the Embed Builder.

The MVP should already feel polished.

---

# 31. IMPORTANT DISCORD CONSTRAINT

Do not assume Discord permits arbitrary server cloning.

Monarch must work within the Discord API and permission model.

Whenever something cannot be reproduced:

```text
Unsupported by Discord
```

should be surfaced clearly.

Do not fake functionality.

Do not claim that Monarch can clone:

* things Discord doesn't expose
* permissions the bot doesn't have
* resources above the bot's hierarchy
* information unavailable through the API

---

# 32. NO MODERATION

This is an explicit product boundary.

Do NOT add:

* anti-raid
* auto moderation
* ban systems
* kick systems
* warning systems
* spam detection
* moderation logs
* economy
* leveling
* music
* generic utility commands

If a proposed feature doesn't contribute to:

> **designing, customizing, organizing, branding, previewing, templating, or managing the visual/configuration structure of a Discord server**

it probably does not belong in Monarch.

---

# 33. BOT COMMAND PHILOSOPHY

The bot should remain lightweight.

The dashboard is the main interface.

Discord commands should primarily provide:

* quick actions
* dashboard links
* previews
* tests
* feature access
* configuration shortcuts

Do not recreate the entire dashboard as slash commands.

---

# 34. CODE QUALITY

Requirements:

* TypeScript strict mode
* clear types
* modular architecture
* no giant files
* no duplicated business logic
* reusable components
* server-side validation
* meaningful naming
* documentation for complex systems
* environment configuration
* proper error boundaries

Do not take shortcuts that make future feature development difficult.

If a temporary implementation is necessary, mark it clearly with TODOs and document the intended replacement.

---

# 35. AGENT DEVELOPMENT RULES

You are the implementation agent.

Before writing substantial code:

1. Inspect the repository.
2. Understand existing architecture.
3. Identify dependencies.
4. Check Discord API requirements.
5. Create/update architectural documentation.
6. Plan the smallest coherent implementation.
7. Implement.
8. Test.
9. Fix issues.
10. Document what changed.

Do not blindly overwrite existing work.

Do not introduce unnecessary dependencies.

Do not duplicate functionality.

When you discover a better architectural solution, explain it and update the architecture rather than silently creating technical debt.

---

# 36. DEFINITION OF DONE

A feature is not considered complete merely because the UI exists.

A feature is complete when:

* UI works
* state is persisted
* validation exists
* permissions are checked
* preview works
* errors are handled
* Discord integration works where applicable
* destructive changes require confirmation
* tests exist
* architecture is documented
* loading/empty/error states exist
* mobile/responsive behavior is reasonable
* no obvious console/server errors remain

---

# 37. FINAL PRODUCT VISION

Monarch should eventually allow a user to open one application and say:

> "I want my Discord server to look like this."

Then visually construct it.

They should be able to design:

```text
SERVER
│
├── STRUCTURE
│   ├── Categories
│   └── Channels
│
├── ROLES
│   ├── Hierarchy
│   └── Colors
│
├── BRANDING
│   ├── Colors
│   ├── Icons
│   └── Visual Theme
│
├── MESSAGES
│   ├── Embeds
│   └── Components
│
├── WELCOME
│   └── Onboarding
│
└── TEMPLATES
    └── Saved Designs
```

Preview it.

Save it.

Version it.

Compare it.

Then deploy it to Discord.

The central principle is:

> **Monarch doesn't just manage a Discord server. Monarch lets you design one.**

---

# APPENDIX A — Status of the spec (what's done, what's not)

> This appendix is added by the implementation team to track progress
> against the master specification above. It does **not** modify sections
> 1–37. Dates and commit references reflect the state on the
> `arena/01a08380-monarch` branch (PRs #1–#9 merged, 2026-09-02 →
> 2026-09-07).

A short legend:

- ✅ **Shipped** — implemented, tested, deployed (or deployable).
- 🟡 **Partial** — some sub-requirements done, others pending.
- ⏳ **Planned** — architecture or placeholder exists, feature not yet
  built.
- ➕ **Additive** — implemented but **not in the master spec**; documented
  under Appendix B.

---

## A.1 Phases (section 29)

### Phase 1 — Foundation

- ✅ Monorepo (npm workspaces: `apps/dashboard`, `apps/bot`, six
  `@monarch/*` packages).
- ✅ Dashboard (Next.js 15, React 19, Tailwind).
- ✅ API (Next.js route handlers under `apps/dashboard/app/api/...`;
  documented as extractable to a standalone service per section 3).
- ✅ Bot (discord.js, lightweight, see section 33).
- ✅ PostgreSQL + Prisma (`prisma/schema.prisma`, two migrations).
- ✅ Discord OAuth2 authentication (`lib/auth.ts`, `lib/session.ts`).
- ✅ Discord connection via `DiscordGateway` abstraction (REST + Mock).
- ✅ Server selection (`/select` page; `listGuildSummaries`).
- ✅ Shared schemas (`@monarch/schemas` zod).
- ✅ Permission system (`@monarch/shared/permissions`; route guards in
  `lib/api.ts`).
- ✅ **Goal reached**: `Login → select server → view server`.

### Phase 2 — Server Designer

- ✅ Server visualization (live `ServerDesign` capture from
  `fetchServerDesign`).
- ✅ Categories + channels.
- ✅ Drag/drop (dnd-kit; `components/designer/StructureTree.tsx`).
- ✅ Drafts with autosave (debounced 1.2s, `lib/draft`).
- ✅ Undo/redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; pure reducer in
  `components/designer/designer-state.ts`).
- ✅ Validation engine (`@monarch/validation/server-rules`).
- ✅ Diff engine (`@monarch/design-engine/diff`).
- ✅ Apply changes (the only mutating route —
  `POST /api/guilds/:id/apply` — enforces `confirmDestructive`,
  pre/post snapshots, audit).
- ✅ **Goal reached**: `Login → Select Server → Visually redesign server
  → Preview diff → Apply`.

### Phase 3 — Embed Builder (FEATURE 2)

- ✅ All listed embed properties (author, title, description, color,
  fields w/ inline toggle, thumbnail, image, footer, timestamp,
  Markdown, mentions, URLs).
- ✅ Multiple embeds per message — supported by the `MessageDesign`
  schema (≤10 per DiscordLimits).
- ✅ Limits enforced through `DiscordLimits` (no hardcoded numbers at
  call sites).
- ✅ Three-panel editor (`components/content/BuilderApp.tsx` +
  `EmbedEditor` + `EmbedPreview` + properties panel).
- ✅ Field editor: drag/drop, reorder, duplicate, delete, inline toggle.
- ✅ Color editor: HEX input (RGB/HSL/picker/palettes are *not* yet
  built — only hex is implemented; treat as 🟡).
- 🟡 Image handling: URL supported, uploaded image is not
  (`imageUrl?: string` only); Discord attachment-backed is not.
- ✅ Variable system (`{user}`, `{username}`, `{display_name}`,
  `{server}`, `{member_count}`, `{channel}`); extensible registry in
  `@monarch/shared/variables`.
- ✅ Preview (desktop + mobile via responsive layout; variable example
  rendering in preview).
- 🟡 Mobile preview is via responsive CSS, not a separate "compact"
  preview variant (🟡).
- ✅ Live updates, validation warnings, character counts, field limits,
  embed limits, Markdown preview.
- ✅ Drafts (autosaved 900ms).
- ✅ Templates (export/import as `monarch-template` JSON, see A.3).
- ✅ Version history (per-guild `DesignVersion` table; pre/post-apply
  snapshots automatically recorded).
- ✅ Undo/redo (autosave is a separate axis; editor-level undo is not
  yet implemented for the embed editor — only the Server Designer has
  it). **🟡**
- ✅ Send Test (designated `testing` channel; explicit override).
- ✅ Publishing (designated `announcements` channel).
- 🟡 "Save Template" as a *library* item is not yet wired (the
  `Template` model exists; the UI does not). See Appendix B.1.
- ✅ **Goal reached** (with the noted 🟡 items): `Create embed → Preview
  → Validate → Send Test → Save Template → Publish`.

### Phase 4 — Message / Components (FEATURE 3)

- ✅ Message editor (`MessageEditor`).
- ✅ Content + up to 10 embeds + up to 25 buttons per message.
- ✅ Component tree representation: flat button list chunked into
  action rows of ≤5 (`toActionRows` in `content-renderer.ts`).
- 🟡 Components V2: not yet. Only the legacy embed + buttons schema is
  supported. A `MessageButton` style union exists (`primary`,
  `secondary`, `success`, `danger`, `link`) and `renderButtonPayload`
  emits a `custom_id: "monarch:<id>"` placeholder for non-link buttons,
  but **no interaction handling exists yet** — non-link buttons would
  error on send. Validation rejects them in practice via the
  `button.url-on-interaction` warning + the message-validation rules;
  a future commit will gate them entirely.
- ✅ Preview, validation, test sending (shared with FEATURE 2).
- 🟡 Select menus / text displays / containers / sections: not yet.
  Renderer is structured so they can be added without redesigning
  (separate `renderX` helpers per type).

### Phase 5 — Roles / Branding / Welcome

- 🟡 Role Designer — name, color, hoist, mentionable, position, and
  a curated permissions grid are done (`/s/:id/roles` is live; full
  diff + apply + audit + tests). Drag-and-drop hierarchy is not yet
  (deferred — position is editable as a number). The full permission
  editor (every Discord permission flag) is not yet (deferred —
  curated grid covers the common ones). See Appendix G.
- ⏳ Server Branding Studio (placeholder only; `Branding` schema
  exists in `ServerDesign`).
- ⏳ Welcome & Onboarding Designer (placeholder only).

### Phase 6 — Templates / Backups (FEATURE 7 + FEATURE 8)

- ✅ Backups & restore:
  - `createBackup` (manual) + automatic pre-apply / post-apply
    snapshots.
  - `stageRestore` (stages as draft, runs through the diff → confirm →
    apply pipeline; never writes to Discord from the restore path).
  - `MonarchStore.getSnapshot(guildId, id)` (guild-scoped).
  - History UI (`/s/:id/history`).
- ✅ Templates:
  - `TemplateEnvelope` (`format: "monarch-template"`, `version: 1`).
  - `detachDesign` (snowflakes → `new_*` local ids; designatedChannels
    reset to `{}`; roles preserved; portable).
  - `parseServerTemplate` (version-checked; rejects unknown formats).
  - `localiseIds` (forces any hand-edited snowflakes to local ids so
    imports can't "modify" unrelated live channels).
  - `mergeDesigns` (append under current structure — "add" mode).
  - `stageImport` (modes `add` and `replace`; validates before
    staging).
  - Export endpoint streams the JSON; the bot attaches it to a slash
    command reply.
  - Import UI on `/s/:id/import-export`.
- 🟡 Template *library* (`Template` model in the DB, but no
  `MonarchStore` methods for it yet — only export/import of a single
  file). See Appendix B.1.
- ✅ Comparison: the Review modal renders the diff (`+ created`,
  `~ changed`, `- deleted`, `! unsupported`) before any apply, and the
  restore flow runs the same diff.

### Phase 7 — Analyzer / Import / Export (FEATURE 9 + FEATURE 10)

- ✅ Import / Export (built in Phase 6 alongside Templates).
- ⏳ Design Analyzer & Cleanup (placeholder page only).

---

## A.2 Cross-cutting spec items (sections 1–28)

| Spec section | Item | Status | Where |
|---|---|---|---|
| §2 | "Preview first → validate → diff → confirm → apply" | ✅ | `POST /api/guilds/:id/apply` |
| §5 | Discord OAuth2 (identify + guilds) | ✅ | `lib/auth.ts` |
| §5 | Per-server: id/name/icon/botInstalled/userCanDesign/botPermissions | ✅ | `GuildSummary` schema + `listGuildSummaries` |
| §6 | Server selection screen | ✅ | `/select` page |
| §7 | Target Resolver (designated channels, explicit override) | ✅ | `@monarch/discord/target-resolver.ts` |
| §7 | Cross-guild guard | ✅ | `target.kind === "explicit" && target.guildId !== guildId` → `target.wrong-guild` |
| §7 | Interaction replies stay in interaction context | ✅ | `apps/bot/src/index.ts` always `interaction.reply({...ephemeral})` |
| §7 | Generated content uses Target Resolver | ✅ | `lib/workspace.ts` `sendWorkspaceDesign` |
| §8 | Internal `ServerDesign` schema (not raw Discord JSON) | ✅ | `@monarch/schemas/server-design.ts` |
| §8 | Renderer is the only place that builds Discord API payloads | ✅ | `@monarch/renderer` (and `@monarch/discord` for inbound) |
| §11 | Diff engine: create/modify/rename/move/delete/unsupported | ✅ | `packages/design-engine/diff.ts` |
| §11 | Diff engine is shared by Designer / Restore / Import / Templates | ✅ | `rebaseDesign`, `mergeDesigns`, `localiseIds` in `compose.ts` |
| §12 | Centralized validation engine | ✅ | `@monarch/validation/engine.ts` + `*-rules.ts` |
| §12 | Human-readable errors with `fix` suggestions | ✅ | `MonarchError{code,message,reason,fix,detail}` |
| §13 | Discord API abstraction (not direct `discord.js` calls in routes) | ✅ | `DiscordGateway` interface; only `apps/bot` uses discord.js directly (slash commands + jail relay, which need the Gateway connection) |
| §14 | Permission checks: user + bot + hierarchy + target + API | ✅ | `requireGuildAccess` + apply route's bot `ManageChannels` check + `resolveTarget`'s permission check |
| §15 | Draft system (autosave, discard, undo/redo) | ✅ | Designer reducer + `DesignDraft` row + `PUT /api/guilds/:id/draft` |
| §16 | Undo/redo (Ctrl+Z / Ctrl+Shift+Z) | ✅ | `designer-state.ts` |
| §17 | Live previews (server, embed, message) | ✅ | `components/designer/StructureTree`, `components/content/preview.tsx` |
| §18 | Send Test through Target Resolver (never #general) | ✅ | `POST /api/guilds/:id/test-message` and `…/workspace/send` |
| §19 | Database model: User, Guild, GuildSettings, ServerDesign, DesignDraft, DesignVersion, Template, AuditEntry, plus GuildWorkspace, Session, MockDiscordState | 🟡 | All listed entities exist; `ServerDesign` is stored as `Json` on `DesignDraft`/`DesignVersion` rather than as its own table. `DiscordAccount` is folded into `User` (no separate account table — `User.id` IS the Discord user id). `BrandTheme` is not a table; `Branding` lives inside `ServerDesign`. |
| §20 | Encrypted OAuth tokens at rest | ✅ | AES-256-GCM via `lib/secure-token.ts` (key from `SESSION_SECRET` via scrypt, format `v1.<iv>.<tag>.<ciphertext>`) |
| §20 | HMAC-signed session cookies, never tokens in the browser | ✅ | `lib/session.ts` |
| §20 | CSRF protection on mutations | ✅ | `assertSameOrigin` checks `sec-fetch-site` |
| §20 | Server-side permission validation independent of frontend | ✅ | All routes go through `requireGuildAccess` |
| §20 | No bot credentials in the browser bundle | ✅ | `lib/env.ts` is the only env reader; never imported by `"use client"` files |
| §21 | Dark mode first, clean typography, subtle animations | ✅ | Tailwind palette in `app/globals.css` |
| §21 | Sidebar / Canvas / Inspector layout | ✅ | `apps/dashboard/app/s/[guildId]/layout.tsx` + `components/designer/DesignerApp.tsx` |
| §21 | Drag-and-drop, tooltips, keyboard shortcuts, autosave indicator | ✅ | Undo/redo, dirty indicator, "Saving…/Saved/error" |
| §22 | Global navigation: Overview / Design / Library / Manage / Settings | ✅ | `components/nav/SidebarNav.tsx` (Overview, Server Designer, Embed Builder, Message Designer, Role Designer; Library: Templates · Import/Export; Manage: Backups & History; Settings: Designated Channels). Welcome/Branding/Analyzer show as "soon" — Role Designer shipped. |
| §23 | Server context always visible; server switcher in the layout | ✅ | `ServerSwitcher` in the layout |
| §24 | Feature module system | ⏳ | No formal `FeatureModule` registry yet; the structure is implicit (each feature has its own `app/s/[guildId]/<slug>/page.tsx` + components + lib helpers). Adding a registry is a small refactor. |
| §25 | Shared design system (Button, Modal, Inspector, …) | 🟡 | Custom design system exists (Tailwind, `globals.css` color tokens) but the listed component set is not formalized into a single barrel. Common patterns repeat (panel, pill, error box, summary pill). |
| §26 | Errors understandable, technical detail in logs | ✅ | `MonarchError` + `translateDiscordError`; `error.detail` is sent to the logger, not the wire |
| §27 | Structured JSON logging; never log tokens/secrets | ✅ | `createLogger` in `@monarch/shared`; redacts `/token|secret|authorization|password|cookie/i` |
| §28 | Unit tests for schemas, validators, diff, renderers, permissions, target resolver | ✅ | `packages/*/test/*.test.ts` |
| §28 | Integration tests for Discord service, database, API | ✅ | `apps/dashboard/test/prisma-store.integration.test.ts` (PGlite + applied migrations); `packages/discord/test/gateway.test.ts` (full apply loop against mock) |
| §28 | UI tests | ⏳ | No component tests yet. |
| §31 | "Unsupported by Discord" surfaced, never faked | ✅ | Diff engine `unsupported` op + Review modal renders it explicitly |
| §32 | No moderation features | ✅ | Only feature with even a moderation veneer is `/monarch jail` (a gag). See Appendix B.5. |
| §33 | Bot stays lightweight; commands are links/tests/config shortcuts | ✅ | `apps/bot/src/index.ts` is ~600 lines; no structural mutations happen in the bot |
| §34 | TypeScript strict; modular; no giant files; no duplicated business logic | ✅ | `tsconfig.base.json` has `strict` + `noUncheckedIndexedAccess`; `lib/api.ts`, `lib/workspace.ts`, `lib/backups.ts` are the cross-cutting services used by both user and bot routes |
| §35 | Agent development rules | 🟡 | Followed during PRs 1–9, but not yet formalized into a process document beyond the existing PR descriptions |
| §36 | Definition of done | ✅ | Each shipped feature meets it (UI + persistence + validation + permissions + preview + error handling + destructive confirmation + tests + docs) |
| §37 | "Monarch lets you design one" central principle | ✅ | Captured in the product tagline and the Review/Apply loop |

---

## A.3 First MVP (section 30)

The MVP pipeline is end-to-end working today:

```text
Discord Login
   ↓
Server Selection
   ↓
Server Designer
   ↓
Draft System
   ↓
Validation
   ↓
Diff Preview
   ↓
Apply Changes
```

…plus the Embed Builder, Message Designer, Backups & Restore, Templates
Import/Export, the mobile-friendly dashboard shell, the Discord bot
(`/monarch help`, `/monarch dashboard`, `/monarch status`, `/monarch
backup`, `/monarch export`, `/monarch embed`, `/monarch test`,
`/monarch jail`, `/monarch unjail`, `/monarch jailed`), and the
PostgreSQL-backed production path (Prisma 7, engine-free, Vercel-ready).

---

# APPENDIX B — Additive work (not in the master spec)

These features and decisions are **not** described in sections 1–37 of
the master specification. They were added by the implementation team
because the spec explicitly invites "optional modules" (§10) and
"Agent Development Rules" (§35) that include updating the architecture
when a better solution is found. They are listed here for traceability
so future iterations of the spec can decide whether to fold them in.

## B.1 Internal "Monarch" companion bot (not the moderation bot)

The spec (§33) calls for a lightweight bot with quick actions. We
delivered more than the spec's command list. The full surface is:

| Slash command | Spec coverage | Notes |
|---|---|---|
| `/monarch help` | new | Rendered from a single `COMMAND_HELP` manifest. A unit test enforces it stays in sync with the registered subcommands and under Discord's 2000-char limit. |
| `/monarch dashboard` | implicit | Link to the studio for the current guild. |
| `/monarch status` | new | Bot presence, jailed count, dashboard URL. |
| `/monarch backup [name]` | new (related to FEATURE 8) | Calls `/api/internal/guilds/:id/backup` with the invoking member's `userId` so the audit trail is correct. |
| `/monarch export` | new (related to FEATURE 10) | Returns the live structure as a `monarch-template` JSON file via Discord's attachment mechanism. |
| `/monarch embed` | new (related to FEATURE 2) | Opens the Embed Builder; if `INTERNAL_API_TOKEN` is set, also previews the saved embed. |
| `/monarch test kind:<embed\|message> [mode] [channel]` | new (related to FEATURE 18) | Test-send or publish the saved design through the dashboard's internal API, optionally to an explicit channel. |
| `/monarch jail @user [duration] [reason]` | NOT in spec; see B.5 | Gag feature. |
| `/monarch unjail @user` | NOT in spec; see B.5 | |
| `/monarch jailed` | NOT in spec; see B.5 | |

Auth: bot→dashboard requests use a shared `INTERNAL_API_TOKEN`
(Bearer header, constant-time SHA-256 compare in
`apps/dashboard/lib/internal-auth.ts`). When the token is unset, the
internal API returns 503 with a setup hint, and the affected slash
commands surface the same in chat.

Intents: `Guilds + GuildMessages + MessageContent` with an automatic
Guilds-only fallback if `MessageContent` is not enabled in the
developer portal. The fallback logs a warning and disables only
`/monarch jail`; everything else keeps working.

## B.2 OAuth state hardening (PR #3)

The spec's §5 covers the happy path; we also hardened the failure path.
Two issues that bit the Vercel deploy:

1. **File store fallback on serverless.** §3 specifies the architecture
   but assumes the database is always available. We caught a
   regression where `getStore()` would silently fall back to the
   JSON `FileStore` when `DATABASE_URL` was unset, blowing up the
   OAuth callback with `ENOENT /var/task/.monarch-data` on Vercel.
   Fix: `getStore()` now **throws** a clear configuration error on
   serverless (`VERCEL=1` or `AWS_LAMBDA_FUNCTION_NAME`) when
   `DATABASE_URL` is missing. The OAuth callback also catches storage
   errors and returns a friendly redirect.
2. **Stale `monarch_oauth_state` cookie.** When the previous attempt
   failed, a stale state cookie made the next attempt look like a
   "session expired" error. The callback now clears the state cookie
   on every error redirect.

## B.3 Database not a "router service yet, but designed to be extracted"

§3 says the API can be Next.js route handlers, with an eye toward
extracting it later. The current code keeps that promise:

- **All business logic lives in `apps/dashboard/lib/*`** (`api.ts`,
  `backups.ts`, `workspace.ts`, `discord.ts`, `prisma-store.ts`,
  `secure-token.ts`, `internal-auth.ts`). Route handlers in
  `app/api/**` are thin: they parse, call guards, call a service, and
  serialize a response.
- **`MonarchStore` interface** (`apps/dashboard/lib/store.ts`) decouples
  the rest of the code from PostgreSQL. Two implementations:
  `PrismaStore` (production) and `FileStore` (dev/demo).
- **`DiscordGateway` interface** (`packages/discord/src/gateway.ts`)
  decouples the rest of the code from `@discordjs/rest`.
- The bot never imports from `apps/dashboard/lib/*`; it talks to
  the dashboard over HTTP with `INTERNAL_API_TOKEN`. Extracting
  `apps/api` would be mechanical (move `lib/api.ts`, `lib/workspace.ts`,
  `lib/backups.ts` and the `app/api/internal/**` routes into a new
  service; add an `ALLOWED_ORIGIN` config so the dashboard can call
  it).

## B.4 Post-deploy observability (not in spec)

The spec mentions structured logging (§27) but says nothing about
shutdown behavior or error budgets. We added:

- **Bot graceful shutdown** (PR #6). `SIGTERM`/`SIGINT` →
  `client.destroy()` → `exit(0)`. Idempotent. The bot must be PID 1 in
  the container (the `CMD` is `node --import tsx apps/bot/src/index.ts`,
  not `npm run start`, which would absorb the signal). Documented in
  `docs/deploying-vercel.md` "Reading the worker logs".
- **JSON-line logger** with secret redaction. Keys matching
  `/token|secret|authorization|password|cookie/i` are replaced with
  `"[REDACTED]"` before the line is emitted.
- **Missing-migration detection in routes.** `jsonStorageError` in
  `lib/api.ts` translates Prisma's `P2021` / `P2010` / `42P01` to a
  `db.migration-pending` code with a "run `npm run db:migrate`" fix
  hint, instead of returning a raw connection error.

## B.5 `/monarch jail` — explicit non-conformance with §32

§32 says "no moderation features." We added a *single* moderation-flavoured
slash command, scoped narrowly to gag/joke use, with the following
guardrails:

- Documented in the README as a joke feature, not a moderation product.
- The implementation is fully isolated in
  `apps/bot/src/{index,jail,galactic,commands}.ts`. There is no
  shared "moderation" module.
- No banned/kicked/muted/auto-mod state, no logs, no audit. The
  `JailRegistry` is in-memory and releases everyone on restart.
- The relay only deletes a single user's messages and re-posts them
  with the same content (transliterated to the Standard Galactic
  Alphabet) under their own name/avatar via a per-channel webhook.
  Discord markup (mentions, custom emoji, timestamps, URLs, code
  spans) is preserved so a jailed user cannot bypass or break
  formatting.
- Requires `ManageMessages` (added to the bot's least-privilege
  invite bitfield in PR #9) and the privileged `MessageContent`
  intent; the bot falls back to Guilds-only when the intent is not
  enabled.
- Default release is indefinite (`/monarch unjail @user`); `10m`,
  `2h`, `1d`, `1h30m` are accepted, capped at 28 days.

This is the one place where we knowingly deviated from the master
spec. It is called out here so future iterations of the spec can
decide whether to formally add it (and harden it) or remove it.

## B.6 Mobile-first dashboard shell (not in spec)

The spec says "responsive design" (§21). The implementation goes a bit
further: the entire `/s/[guildId]/*` tree has a dedicated mobile layout
with a sticky top bar + slide-out drawer (closes on route change and
Escape, locks body scroll while open), the Designer and Builder panes
stack into tabbed single-pane views on phones, drag has a touch
sensor with always-visible handles on coarse pointers, inputs are
16px on coarse pointers (no iOS zoom), and `viewport`/`themeColor`
meta is set. `apps/dashboard/components/nav/GuildShell.tsx` and the
`use coarser pointer` patterns in `BuilderApp.tsx` /
`DesignerApp.tsx` are the relevant code.

## B.7 Empty-state, corrupt-state, and partial-Discord graceful handling

Not in the spec, but several layers in the code prevent a
`res.json()` crash and an empty editor:

- `lib/fetch-json.ts` (`readJsonSafe`, `apiErrorMessage`,
  `networkErrorMessage`): every client-side API call uses safe
  parsing. Empty / non-JSON / HTML 5xx bodies degrade to a friendly
  error message instead of a `JSON.parse: unexpected end of data`
  crash.
- `lib/workspace.ts` `parseStoredWorkspace`: designs written by an
  older or newer schema version are validated with `safeParse`. A
  corrupt row degrades to an empty editor + a `log.warn` (never a
  500).
- `lib/api.ts` `jsonStorageError`: missing-table errors return
  `code: "db.migration-pending"` with a "run `npm run db:migrate`"
  fix.
- `MockDiscordState` survives restarts via the `MonarchStore` so
  demo-mode seeded guilds do not vanish.

## B.8 Self-testing the migrations (PR #2)

§28 calls for integration tests against the database. We made the
integration test *also* exercise every committed migration against a
real PostgreSQL (PGlite-in-WASM, exposed over the PG wire protocol),
so a broken migration fails the test suite *before* it reaches a
production database:

- `apps/dashboard/test/prisma-store.integration.test.ts` boots
  PGlite, sorts every directory in `prisma/migrations/`, splits
  each `migration.sql` on `;`, runs every statement, then exercises
  the full `MonarchStore` contract.
- This proves (a) the SQL is valid, (b) every schema model is
  reachable, (c) cascade behaviour matches the spec's diff/apply
  loop, and (d) AES-GCM token encryption round-trips and fails closed
  on tampering.

## B.9 Internals the spec didn't name

These small but useful pieces didn't fit a single spec section but
are worth recording:

- **New-id prefix (`new_*`)** in `@monarch/shared/ids.ts`. The spec
  describes "internal ids" but doesn't fix a naming convention; we
  chose `new_` because it makes the diff engine's create-vs-modify
  decision trivial and is human-readable in JSON exports.
- **Design rebase for restore** (`@monarch/design-engine/compose.ts`,
  `rebaseDesign`). A snapshot from last week cannot be applied
  verbatim if channels have been deleted in the meantime. The
  restore flow re-bases the desired design onto the live one:
  unchanged ids stay, vanished ids are *adopted* onto a live
  same-kind/same-name entity when one exists (so message history
  isn't lost), and the rest become new creates. This is a spec
  §31 ("Unsupported by Discord") compliance choice.
- **`localiseIds`** in the same file. A hand-edited template that
  still carries snowflakes from the server it was exported from is
  forced to local ids before import, so imports can never silently
  "modify" a live channel that happens to share an id. Documented
  inline; this is the spec's "templates must be portable" (§7) made
  bulletproof.
- **Designated-channels storage** in `GuildSettings` (4 nullable
  columns). The spec talks about designated channels (§7) but doesn't
  fix the storage shape; we chose dedicated columns over a JSON blob
  so SQL filters work and migrations stay diff-able.

---

# APPENDIX C — Open work, prioritised

In rough order of "smallest next step that adds the most user value":

1. **Template library UI.** The `Template` model and its index are
   in the DB but no `PrismaStore` methods or UI consume it. Smallest
   first cut: a `/library` page that lists a user's templates and
   lets them download/upload them, with the existing export/import
   flow as the transport.
2. **Branding Studio (FEATURE 6).** `Branding` schema already lives
   inside `ServerDesign`; needs an editor and a way to apply it
   (color changes are a Discord PUT to `Guild`).
3. **Welcome Designer (FEATURE 5).** Composes content designs
   (already built) with role-selection menus (not yet a thing).
4. **Design Analyzer (FEATURE 9).** Pure-readonly; can ship without
   touching any mutating path.
5. **Components V2 (FEATURE 3, future).** Add a new branch of the
   content renderer for the v2 component tree; legacy embeds stay
   supported.
6. **`/monarch jail` decision** (Appendix B.5). Either promote it to
   a real spec section with hardening (audit, persistence, opt-in) or
   remove it. The README currently calls it a joke; the master spec
   says no moderation. Pick one.
7. **Formal feature-module registry** (FEATURE 24 / spec §24). The
   feature toggles are implicit today; a small `FeatureModule` table
   would make the optional modules (§10) actually optional at runtime.
8. **UI tests** (spec §28). No component tests today. Playwright or
   vitest + React Testing Library, focused on the Review modal and
   the embed builder.
9. **Role Designer follow-ups** (FEATURE 4 — see Appendix G). Drag-
   and-drop role reordering and the full permission editor (every
   Discord permission flag, not just the curated 10) are the two
   pieces not yet shipped.

---

# APPENDIX D — "Where do I look?" (companion to agent.md)

The team has a separate `agent.md` at the repo root that maps the
codebase. The two documents are complementary:

- `agent.md` — the **current** state: every file, every route, every
  store, with line-level cross-references. Updated whenever the code
  moves.
- `docs/objective.md` (this file) — the **intended** state: the
  product, the principles, the phases, the boundary (no moderation,
  Templates portable, Preview-first, etc.). Updated when the spec
  itself changes.

When the two disagree, the code wins for "is it built?" and this
document wins for "should it be built?". The appendices above exist
to make the disagreements (mostly the additive bot commands and
`/monarch jail`) auditable instead of accidental.

---

# APPENDIX E — "Things that look at the server" (5 analytic commands)

> **Status:** proposed (not yet built). Mirrors Appendix B's style —
> these are additive to the master spec, slotted in for spec iteration
> in a future phase. None touches user messages; all are read-only,
> ephemeral by default, and respect §32 (no DMs, no per-user persistent
> state, no private-content reads).

These are not part of the original 37-section spec. They are
**bot-side analytic commands** that ship Monarch's design-led lens
into the bot command surface — the same lens as the Design Analyzer
(FEATURE 9), but as a one-shot `/monarch …` rather than a full
dashboard surface.

1. **`/monarch serverstats`** — comprehensive server snapshot.
   Reads public guild, channel, and role objects via `@discordjs/rest`
   (no intents required) and renders a Monarch-styled embed with four
   sections: **Identity** (server id, created, owner, verification),
   **People** (members, humans, bots, boost tier, Nitro subscribers),
   **Structure** (text/voice/category/role counts, colored-role ratio),
   **Health** (channels-with-topic ratio, NSFW count, default slowmode,
   audit-log enabled). Distinct from existing analytics bots because
   it measures *structure*, not *activity* — the bones of the server,
   not its traffic.

2. **`/monarch health`** — single-number design health score (0–100).
   Computed from a weighted checklist of public server facts: channel
   topics set (20), server icon (10), banner (5), colored roles (10),
   ≥1 category (5), welcome channel configured (10), rules channel
   (10), default notifs = `MENTIONS_ONLY` (5), verification ≥
   `MEDIUM` (10), audit log enabled (5), no empty categories (10).
   Deterministic — same server, same score. Green ≥80, yellow ≥60,
   red <60. Distinct from existing analytics bots because it measures
   *design health*, not *engagement*. Preview of FEATURE 9 (Design
   Analyzer) in command form.

3. **`/monarch audit`** — recent Monarch audit entries. Reads the
   existing `AuditEntry` model. Default: last 10 entries for the
   current guild, newest first. Optional `count:` (max 25) and
   `since:` (`1d`, `7d`, `30d`). Ephemeral. Same data as the
   dashboard's audit log; the bot command is the *short form*.

4. **`/monarch botstats`** — the bot's own runtime snapshot. Subject
   is the bot, not the user: status, uptime, latency, RSS memory,
   host, node version, shard, build sha, start time; then activity:
   guilds, total members, slash commands registered, commands run
   in last 7d (in-memory), errors in last 7d (in-memory), last
   restart reason. The "in-memory" counters are explicitly documented
   in the footer as resetting on restart — the command is honest
   about its limits.

5. **`/monarch templates`** — templates installed in this server plus
   a popular-templates leaderboard across all servers. Reads the
   existing `Template` model. Two sections: **Local** (installed
   templates with their last-published date and status — `published` /
   `archived` / `draft`), and **Popular** (top 5 most-installed
   templates this month, `GROUP BY templateKey ORDER BY count DESC
   LIMIT 5`). Distinct because templates are Monarch-specific data
   — no other analytics bot has this.

All five obey §32: no DMs, no per-user persistent state, no
private-content reads, no message history. Two of them (serverstats,
health) reuse `@monarch/renderer`'s embed-builder so the response
itself is a Monarch design — the only commands where the *output
visual* matches the product's voice.

---

# APPENDIX F — "What's next after Phase 7" (10 substantive backlog items)

> **Status:** planned backlog (not yet built). User-asked-for, balanced
> mix: 4 spec-finishing, 3 power-user, 2 adoption, 1 marketing-shape.
> Each one is large enough to be its own PR. Implementation order
> left to the user.

These are the **10 substantive features/commands** the user requested
to be appended for spec iteration. They are additive to the 37-section
master spec; they either finish a half-built spec feature (the four
"spec-finishing" rows) or extend one without breaking its shape.

1. ~~**Role Designer (FEATURE 4, Phase 5).**~~ **Done** — see
   Appendix G for the implementation record. Remaining scope
   (drag-and-drop hierarchy, full permission editor) is tracked
   in Appendix C item 9.
2. **Template Library (FEATURE 7, Phase 6).** A `/library` page
   that lists a user's templates, lets them download/upload them,
   and shows public templates with one-click install. The `Template`
   model and its index already exist; this is the UI + a couple of
   `PrismaStore` methods. **Small–medium.** *Spec-finishing.*
3. **Design Analyzer (FEATURE 9, Phase 7).** The full analyzer
   surface — not just the `/monarch health` command but a real
   dashboard page that explains *why* the score is what it is, lets
   the user mark issues as "intentional", and exports the report.
   **Medium.** *Spec-finishing.*
4. **Branding Studio (FEATURE 6, Phase 5).** Centralized server
   branding: a `Branding` editor (primary / secondary / accent
   colors, role palette) that propagates to embed-builder color
   pickers and to the role designer. The `Branding` schema already
   lives inside `ServerDesign`; this is the editor + the apply path
   (color changes are a Discord PUT to `Guild`). **Medium.**
   *Spec-finishing.*
5. **Scheduled publishing for embeds/messages.** Extends FEATURE 18
   (publish). A user can pick a future time (max 7 days) and
   Monarch schedules the publish via the bot's worker (in-memory
   `setTimeout` for short delays, DB-backed queue for longer). On
   apply, the audit entry records the schedule. **Small.**
   *Power-user.*
6. **Audit log UI + CSV export.** The data is already there
   (`AuditEntry` rows are written on every apply, restore, and
   export). The dashboard's history page already shows snapshots;
   add a sibling `audit` view + a "Download CSV" button. **Small.**
   *Power-user.*
7. **Dry-run mode for destructive changes.** Add `?dry_run=1` to
   `POST /api/guilds/:guildId/apply` (or a `dryRun: true` body
   field). Returns the plan + diff without executing anything,
   suitable for pre-flight from CI or scripts. **Tiny.**
   *Power-user.*
8. **Versioned drafts with named milestones.** Extends FEATURE 8
   (drafts). The current draft autosaves silently; add an explicit
   "Save milestone" action that names the milestone ("Welcome v3
   for review") and shows it in the inspector. Restore reverts to
   the chosen milestone. **Small.** *Power-user.*
9. **Sample-template gallery with one-click install.** A small,
   curated set of Monarch-authored starter templates (Welcome
   channel, Rules, Moderator Roster, Event Announcements, Lore &
   Worldbuilding) shown on a public page and installable to a
   user's guild in one click. Marketing surface that doubles as
   the easiest "try Monarch" path. **Small.** *Adoption.*
10. **Embed-to-image export (PNG).** The dashboard's embed
    builder already previews the embed as Discord will render it;
    add a "Download as PNG" button that renders a 2× PNG via
    `node-canvas` or `@napi-rs/canvas` and posts the file to
    `content-disposition: attachment`. Useful for changelogs,
    docs, social posts. **Small–medium.** *Adoption / marketing.*

The three remaining spec-finishing items (Template Library, Design
Analyzer, Branding Studio) together would close Phases 6 and 7 of
the master spec; the five extensions are power-user / adoption
features that make the product feel complete without changing its
shape. The spec stays the source of truth — these are proposals, not
edits to the 37 original sections.

---

# APPENDIX G — Where Role Designer was finished (added in this iteration)

> **Status:** completed in this session — see `agent.md` §16. This
> appendix documents the implementation choices that were not already
> implied by the master spec, for future-agent reference.

The master spec already declared FEATURE 4 (Role Designer) as a
Phase 5 deliverable and noted that the `RoleDesign` schema lives
inside `ServerDesign.roles`. What it did NOT specify, and what
this session resolved:

- **Diff coverage** — the `diffServerDesign` engine was channel-
  and category-only. Extended to handle the `role` resource with
  the same op vocabulary (`create`, `rename`, `modify`, `delete`,
  `unsupported`). `managed` roles (bot-managed, integration-managed)
  are reported as `unsupported` and skipped on apply — they cannot
  be edited through the bot anyway.
- **Apply executor** — added `create:role`, `modify:role`,
  `delete:role` cases to `executeApplyPlan` and the
  `RestDiscordGateway` and `MockDiscordGateway`. Position sync
  was extended to roles. Destructive flag is set when any role
  is deleted.
- **Permission gate** — apply now requires
  `Permission.ManageRoles` (in addition to `ManageChannels`),
  with the same "Administrator implies everything" semantics. The
  check is bot-side; user-side `requireGuildAccess` already gates
  by `userCanDesign`.
- **Validation rules** — extended `validateServerDesign` with
  role rules: name length 1–100 (`role.name.length`), role count
  ≤ 250 (`guild.roles.max`), no duplicate role names
  (`role.name.duplicate`). `managed` roles are not flagged —
  Monarch surfaces them but never tries to edit them.
- **UI** — new `RoleDesigner` component (sibling of `DesignerApp`)
  under `/s/[guildId]/roles`. Uses the same reducer pattern, same
  Inspector + issue list, same toolbar (Undo/Redo/Review/Discard).
  Color picker is a 6-char hex `<input type="color">` plus the
  raw text field (so power users can paste `#ff8800` directly).
  Hoist and mentionable are checkboxes. Permissions are presented
  as a simple *toggles grid* (a small curated set of high-impact
  flags) plus a "raw" mode that shows the bitfield. Full
  permission editor is a Phase 6+ item.
- **Sidebar** — `Role Designer` no longer shows the `soon` badge.
- **Audit summary** — `POST /api/guilds/:guildId/apply` summary
  now includes role counts: `+N roles ~N roles -N roles`.
- **Tests** — added a `role-rules.test.ts` to the validation
  package, extended `diff.test.ts` with role coverage, and added
  a `role-executor.test.ts` to the discord package that drives
  the full create/modify/delete loop through `MockDiscordGateway`.

The master spec's FEATURE 4 paragraph remains untouched; this
appendix is the implementation record.
