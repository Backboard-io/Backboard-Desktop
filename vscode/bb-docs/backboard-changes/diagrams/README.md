# ASCII Diagrams

## Browser Screenshot To Chat Flow

```text
User clicks titlebar screen icon
          |
          v
+-----------------------------------------------+
| workbench.action.sessions.addBrowserArea...   |
+-----------------------------------------------+
          |
          v
+-----------------------------------------------+
| IEditorService.activeEditor                   |
| - if BrowserEditorInput and contextual: use it |
| - else open first contextual browser input     |
+-----------------------------------------------+
          |
          v
+-----------------------------------------------+
| ICommandService.executeCommand(...)           |
| BrowserViewCommandId.AddAreaScreenshotToChat  |
+-----------------------------------------------+
          |
          v
+-----------------------------------------------+
| Browser editor area selection UI              |
+-----------------------------------------------+
          |
          v
+-----------------------------------------------+
| Screenshot attachment enters chat context     |
+-----------------------------------------------+
```

## Titlebar Space While Browser Editor Is Active

```text
Normal session titlebar:

+---------------------------------------------------------------+
| [Sidebar]       Session title / branch          [Account][...] |
+---------------------------------------------------------------+

Browser editor active:

+---------------------------------------------------------------+
| [Sidebar]       Browser/editor controls          [Screen][...] |
+---------------------------------------------------------------+

Code path:

IEditorService.onDidActiveEditorChange()
  -> activeEditor instanceof BrowserEditorInput
  -> account widget display = 'none'
  -> aria-hidden = 'true'
  -> hover/menu cleared
```

## Auxiliary Bar Width Change

```text
Before, editor visible:

+----------------------+------------------------------+
| Editor / Session     | Auxiliary Bar                |
|                      | min about 180-280px          |
|                      | default about 38% of column  |
+----------------------+------------------------------+

After, editor visible:

+------------------------------------+----------------+
| Editor / Session                   | Auxiliary Bar  |
|                                    | min 120-180px  |
|                                    | default 24%    |
+------------------------------------+----------------+
```

## Sidebar Header Navigation

```text
Before:

SidebarPart.createTitleArea(parent)
  -> super.createTitleArea(parent)
  -> prepend navigation into title area

After:

SidebarPart.create(parent)
  -> super.create(parent)
  -> setHeaderArea(navigation)
  -> append navigation buttons

Visual:

+------------------------+
|  [Explorer][Search]... |  <- header area
+------------------------+
|  Sidebar title/content |
|                        |
+------------------------+
```

## Backboard Composer Chrome

```text
Before:

+-------------------------------------------------------------------+
| [Mode v] [Model v]                      [Web][Image][Usage][Mic]  |
| Message Backboard...                                      [Stop][Send]
+-------------------------------------------------------------------+

After:

+-------------------------------------------------------------------+
| [Mode v] [Model v]                      [Web][Image]       [Mic]  |
| Message Backboard...                                      [Stop][Send]
+-------------------------------------------------------------------+

The usage popover functions still exist, but the direct composer usage
button and event listeners were removed from this UI row.
```

