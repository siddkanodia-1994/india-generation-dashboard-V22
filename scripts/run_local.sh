#!/bin/bash
# Local Mac automation for Grid India PSP scraper.
# Installed as a launchd job — runs every 30 min, 9:00 AM–1:00 PM IST daily.
# Idempotent: skips gracefully if data already present or not yet published.

REPO="/Users/siddhantkanodia/Documents/Claude Working Folder/Power Daily Data/india-generation-dashboard-V21"
PYTHON="/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3"
LOG="$REPO/scripts/run_local.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] --- Starting Grid India scraper ---" >> "$LOG"

cd "$REPO/scripts"
$PYTHON run_all.py --mode generation >> "$LOG" 2>&1
EXIT=$?

if [ $EXIT -eq 0 ]; then
  cd "$REPO"
  git config user.name  "local-mac[bot]"
  git config user.email "local-mac@localhost"
  git add public/data/
  if ! git diff --cached --quiet; then
    git pull origin main --rebase >> "$LOG" 2>&1
    git commit -m "auto: update generation data $(date +'%Y-%m-%d') [local]" >> "$LOG" 2>&1
    git push origin main >> "$LOG" 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Data committed and pushed." >> "$LOG"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Data already present — nothing to commit." >> "$LOG"
  fi
elif [ $EXIT -eq 2 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⏳ Not yet published — will retry at next scheduled time." >> "$LOG"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Scraper error (exit $EXIT) — check log above." >> "$LOG"
fi
