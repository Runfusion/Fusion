# KB-664

The dashboard model dropdowns should:
1. Show models from all authenticated providers configured in pi (currently only showing one set)
2. Allow users to favorite providers via global settings, with favorites appearing at the top of dropdowns

**Current behavior:**
- The `/api/models` endpoint uses `modelRegistry.getAvailable()` which returns only authenticated models
- The CustomModelDropdown component groups models by provider

**Required changes:**
1. Backend: Add `favoriteProviders?: string[]` to GlobalSettings
2. Backend: Update `/api/models` to also return provider metadata (not just models)
3. Frontend: Update CustomModelDropdown to accept provider favorites and sort providers accordingly
4. Frontend: Add ability to toggle favorites in the dropdown (click star icon on provider groups)
5. Frontend: Persist favorites via global settings API
