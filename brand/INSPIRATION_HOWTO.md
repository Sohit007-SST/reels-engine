# How to give feedback and example reels

Edit `brand/inspiration.json` (open it with `open -e brand/inspiration.json`), or just tell Claude in chat
("add this reel as inspiration: <link> — I like the hook") and Claude will add it for you.

| Field         | What to put                                          | Example                                                                                                                             |
| ------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `feedback`    | Notes on our own reels                               | `{ "date": "2026-11-10", "note": "Hooks are too slow, cut the first word" }`                                                        |
| `inspiration` | Reels you like (any creator) + what exactly you like | `{ "link": "https://www.instagram.com/reel/...", "whatILike": "zoom-in on a planet in the first frame", "useFor": "visual_style" }` |
| `topicIdeas`  | Topics you want covered                              | `"What if the Sun was blue?"`                                                                                                       |
| `avoid`       | Things you never want                                | `"Dinosaurs"`, `"Horror tone"`                                                                                                      |

`useFor` is one of: hook, format, pacing, visual_style, topic, voice, other.

**How it's used:** every daily run, the idea writer reads this file and gives your topics and liked patterns
strong weight. Links are only notes for the AI — the system never downloads, copies or re-uploads anyone
else's video, audio or words (Instagram's originality rules; copying kills reach).
