---
'@adonis-agora/agent-dashboard': patch
---

The App and Organization pickers are now the kit's shared header picker (the same as telescope's): the noun on the left, a searchable list, a chip when there is only one choice. Going to another console keeps `?app=` / `?tenant=`, so the picked app no longer falls back to this app after a trip through the switcher, ⌘K or search. Back/forward to an entry with another `?tenant=` now updates the Organization picker and reads the pages again for it.
