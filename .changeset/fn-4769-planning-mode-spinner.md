---
"@runfusion/fusion": patch
---

Fix missing spinner when creating tasks from Planning Mode. The "Create Single Task", "Break into Tasks", and "Create Tasks" buttons now show an inline loading spinner while the async create/breakdown call is in flight, instead of leaving the user staring at an unchanged button or AI-question copy.
