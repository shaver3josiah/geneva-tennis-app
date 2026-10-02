# Research behind the match tracker (October 2026)

What the coach should see, what the models can do from a phone on the back fence, and the
open-source work the tracker builds on. Links go to the primary sources.

## 1. The stats that matter to a college coach

Ranked by coaching value. S = strategy, T = technique, M = mindset, X = scouting.

| # | Stat | Use | Why it earns its place |
|---|---|---|---|
| 1 | Points won in rallies of 0–4 shots (and serve +1 / return +1) | S X | About 70% of points end within four shots (0–4 / 5–8 / 9+ ≈ 70 / 20 / 10). Winning the first four shots wins the match well over 90% of the time ([Brain Game Tennis](https://braingametennis.com/one-minute-clinic-focus-on-the-first-4-shots-in-practice/); [Fitzpatrick 2024](https://pmc.ncbi.nlm.nih.gov/articles/PMC11235650/)). |
| 2 | First-serve points won %, read with first-serve-in % | S | The largest winner/loser gap in ~4,400 college matches, 2017–19 ([Tennis Analytics](https://www.tennisanalytics.net/mens-college-tennis-case-study/)). College first-serve-in averages ~63%. |
| 3 | Second-serve points won %, double faults | S M | College winners vs losers: double faults 2.8 vs 3.4 (men), 3.6 vs 4.6 (women). |
| 4 | Return in play %, return points won, return depth | S | The "returns made" gap is about 3 per match. |
| 5 | Winners / forced / unforced errors by wing | T X | Errors are the strongest losing correlate; the wing split finds the weak side, on both sides of the net. |
| 6 | Pressure points: break points, no-ad deciding points, 30-30, tiebreaks | M S | In no-ad, the deciding point swings the game 100%; 30-40 about 55–62%. |
| 7 | Serve placement (Wide / Body / T) by side | X S | The direct scouting read. Players drift to their most reliable spot on big points ([Tennis Abstract](https://www.tennisabstract.com/blog/2019/02/07/break-point-serve-tendencies-on-the-atp-tour/)). |
| 8 | Net approaches and net points won | S | College winners took 55% of net points and won about 67% of them ([Brain Game Tennis](https://braingametennis.com/the-net-gets-no-respect-that-changes-now/)). |
| 9 | Rally-length win %, shot direction, depth | S X | Diagnoses a style mismatch. |
| 10 | Runs, the point after an error, first point of the game | M | Cheap flags. The effects are small, so the app alerts on runs, not single points. |

**Mindset signals the data supports.** These are pressure-point win % against normal points, error contagion (an error after an
error), runs, and tempo between points. Pros won 65.9% of first-serve points on break points against 73.4% otherwise ([Meffert
2018](https://onlinelibrary.wiley.com/doi/10.1080/17461391.2018.1490821)). Gaps are larger for weaker players ([Klaassen &
Magnus](http://www.janmagnus.nl/papers/JRM057.pdf)). All of these are proxies, not validated mental-toughness scores.

**Depth zones.** The tracker uses the Match Charting Project zones in metres: **deep** is the last 3 m (10 ft) before the
baseline, **mid** runs from there to the service line, and **short** is inside the service line ([MCP guide](https://www.tennisabstract.com/blog/2015/09/23/the-match-charting-project-quick-start-guide/)).

**Sanity ranges.** App-measured Division III first serves average about 70 mph (SD 12–14;
[study](https://digitalcommons.wku.edu/ijesab/vol2/iss17/90)). College rally balls run about 40–65 mph. Forehand topspin runs about
1,200–2,500 rpm at college level; the ATP average is 2,708 rpm ([ATP](https://www.atptour.com/en/news/sinner-2024-insights)).

**Formats** (ITA rulebook I.B, unchanged for 2026-27). Duals are three doubles then six singles. Doubles is one set to 6 with a
7-point tiebreak at 6-all. Singles is best of three, with a full third set. Everything is no-ad: the receiver chooses the side
for the deciding point. The 10-point match tiebreak replaces a third set only in the shortened format, once the dual is decided.
Players change ends after the odd games of each set, counted afresh every set, and every 6 points in a tiebreak (ITF Rule 10).

**Coaching during a match.** ITA I.M.9 lets coaches use phones "for texting and data purposes". It bars tablets, video replay
and "Player Analysis Technology" for coaching during a match. Players may use no devices. Get written clearance before coaching
off the live feed.

## 2. What exists in open source

No open-source project covers the whole feature list. SwingVision, which is closed, is the only product with this exact
fence-mounted setup ([setup guide](https://swing.vision/guides/set-up-your-recording)). It claims speeds within 10% and runs
on-device neural networks trained on 500M shots.

| Project | What it does | Use here |
|---|---|---|
| [TrackNet](https://github.com/yastrebksv/TrackNet), [TennisCourtDetector](https://github.com/yastrebksv/TennisCourtDetector), [TennisProject](https://github.com/yastrebksv/TennisProject) | Heatmap ball detection, 14-keypoint court net, bounce model | The three-frame idea; too heavy for a phone browser |
| [abdullahtarek/tennis_analysis](https://github.com/abdullahtarek/tennis_analysis) | YOLOv8 players + ball, court keypoints, speed via a mini-court | Pipeline shape (detect, homography, speed) |
| [antoinekeller/tennis_shot_recognition](https://github.com/antoinekeller/tennis_shot_recognition) | MoveNet pose + GRU classifier of forehand / backhand / serve | The pose-sequence approach to stroke form |
| [WASB-SBDT](https://github.com/nttcom/WASB-SBDT) (MIT) | HRNet ball detector, 1.5M params, tennis F1 ≈ 0.95 | Best upgrade candidate (see §4) |
| [TrackNetV4](https://github.com/TrackNetV4/TrackNetV4) (MIT) | Frame-difference "motion prompt" inside the net, F1 ≈ 0.975 | Confirms frame differencing as the core signal |
| [TT3D](https://arxiv.org/abs/2504.10035), [SynthNet](https://github.com/flexfalk/3DTennisBallTrajectory) | Monocular 3D trajectory with drag and Magnus | The physics fit used here |
| [MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker) (Apache-2.0) | 33-point body pose in the browser, 2D and 3D | Used: both players |

License notes: YOLO11 and YOLO26 are AGPL-3.0 and are avoided. TrackNetV5 is academic-only. Several popular tennis repos
carry no license file at all, which means all rights reserved.

## 3. What the tracker does, and why

- **Camera.** On iOS 17+ the default back camera is a virtual multi-lens device whose zoom reaches **0.5**, so the tracker applies
  the minimum zoom. Many Android WebViews cannot reach the ultra-wide lens at all; Chromium clamps zoom at 1x. For those
  phones the calibration accepts the near service line plus the far corners.
- **Court.** You tap four points, which gives a homography. The tracker then recovers focal length, rotation and camera
  position from it (Zhang's constraints, principal point at the image centre). The tracker reports the lens angle and camera
  height it found, so a bad calibration is obvious.
- **Two bodies, two detectors.** One MediaPipe Pose Landmarker reads the full frame for the near player. A second reads an
  up-scaled crop of the far half, where the far player is only ~5% of the frame height through a 0.5x lens. Separate detectors
  give separate identities, so foreground and background can never swap. Ends change by the ITF rule, so the app always knows
  which named player is near.
- **Ball.** A three-frame difference marks where this frame differs from both of the previous two, which erases the ghost of
  where the ball just was. An optic-yellow colour check and connected components follow, then a constant-acceleration track.
  This is the classical cousin of TrackNet's three-frame input, cheap enough for a phone.
- **Pace, spin, net clearance.** Each hit-to-bounce flight is fitted in two stages. Stage 1: launch speed and angle from the
  two events. Stage 2: angle and spin against the tracked pixels, with a drag + Magnus model (Cd ≈ 0.55, CL = 1/(2 + v/rω)).
  On the demo's rendered pixels this measures pace within **1.6 mph RMS** of the simulation's truth.
- **Swing speed.** Racket-head speed comes from impact physics, v_out = e·v_in + (1+e)·V with e ≈ 0.42
  ([Cross & Lindsey](https://twu.tennis-warehouse.com/learning_center/racquetpower.php)), not from wrist pixels. No reliable
  published wrist-to-racket ratio exists.
- **Form.** These come from MediaPipe's 3D world landmarks: the minimum knee angle in the load, trophy-position knee bend on
  the serve, stance width over hip width, hip–shoulder separation, and a split-step hop before the opponent's contact. Trend
  clips replay the body as a skeleton: legs in optic yellow, trunk and arms in gold.
- **Trend alerts.** Twelve detectors cover first-serve drop, double-fault clusters, errors on one wing, the reset after an
  error, pressure points, opponent serve patterns, long-rally losses, short balls, fading knee bend, missed split steps, runs and
  falling serve pace. They mute for 12 points after firing, so the panel stays readable.

## 4. Expected accuracy, and the upgrade path

- **Near court:** the player and the ball are well resolved, and pace, depth, form and serve placement are dependable.
- **Far court:** the ball is 1–3 px at 1080p, so pace and depth there are coarser and spin is a class (top, flat, slice) more than an rpm.
  The far player's gross form reads; fine joint angles do not.
- **Charting:** keep the one-tap confirm, as SwingVision itself does for scoring.
- **Upgrades, in order of value.** First, run **WASB** (MIT, 1.5M params) on ROI crops through onnxruntime-web, after a short
  fine-tune on Geneva's own footage. Second, swap the far-crop pose model for **RTMPose-s** with a small detector (Apache-2.0). Third, if Android
  0.5x is essential, add a native camera path. All three plug into the same `tracker/vision.js` interfaces.
