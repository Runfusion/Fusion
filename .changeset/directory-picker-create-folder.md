---
"@runfusion/fusion": minor
---

Add "New folder" button to DirectoryPicker for project setup

The directory picker in the project setup flow now includes a "New folder"
button that lets users create folders directly when selecting a project path.
This includes:

- New `POST /api/create-directory` endpoint for creating directories
- Create folder UI in DirectoryPicker with inline error handling
- Keyboard support (Enter to create, Escape to cancel)
- Client-side validation for folder names (no path separators or traversal)

Also fixes a bug where navigating into an empty folder would revert to the
previous directory.
