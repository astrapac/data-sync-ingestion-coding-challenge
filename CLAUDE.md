# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Engineering Philosophy

1. **Challenge conventions** - Question assumptions. Call out code smells.
2. **Be direct** - Truth over comfort. No sugar-coating.
3. **Stay humble** - Learn constantly. Every bug is a teacher.
4. **Deliver beyond expectations** - Leave things better than you found them.
5. **Strive for excellence** - Make it work, make it right, make it fast -- in that order.

- Follow SOLID principles

**Mastery Mindset:**

- Perfect is the enemy of shipped -- but shipped without standards is unmaintainable
- Test like production depends on it -- because it does
- Refactor fearlessly -- comprehensive tests are your safety net
- Exercise critical thinking -- question everything
- Keep energy high -- engineering is exciting, treat it that way

## Project Overview

This is a coding challenge to build a production-ready **TypeScript** data ingestion system that extracts 3,000,000 events from the DataSync Analytics API and stores them in PostgreSQL. The solution must run entirely in Docker via `sh run-ingestion.sh`.

## Key Commands

```bash
# Start all services (builds and runs in Docker)
sh run-ingestion.sh

# Start infrastructure only (PostgreSQL)
docker compose up -d

# Rebuild and restart
docker compose up -d --build

# Check ingested event count
docker exec assignment-postgres psql -U postgres -d ingestion -t -c "SELECT COUNT(*) FROM ingested_events;"

# View ingestion service logs
docker logs -f assignment-ingestion
```

## Architecture Requirements

- **Language:** TypeScript (Node.js 20+)
- **Database:** PostgreSQL 16 (provided via docker-compose at `localhost:5434`, internal port 5432)
- **Containerized:** All solution code goes in `packages/` directory, with Dockerfile(s) and services added to `docker-compose.yml`
- **Entry point:** `run-ingestion.sh` starts `docker compose up -d --build`, then monitors progress by polling the `ingested_events` table and watching for "ingestion complete" in container logs

## API Details

- **Base URL:** `http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1`
- **Dashboard:** `http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com`
- **Auth:** `X-API-Key` header (preferred over query param for better rate limits)
- **Main endpoint:** `GET /api/v1/events` with `limit` and `cursor` query params
- **Response shape:** `{ data: [...], hasMore: boolean, nextCursor: string }`
- **API key expires 3 hours after first use**
- **Documentation is intentionally minimal** — the API has undocumented behaviors and capabilities; explore response headers and the dashboard thoroughly
- **Timestamp formats vary** across responses — normalize carefully

## Infrastructure Config

- **PostgreSQL:** user=`postgres`, password=`postgres`, db=`ingestion`, host=`postgres` (in Docker network), port=`5432` internal / `5434` external
- **Docker network:** `assignment-network` (bridge)
- **Container names:** `assignment-postgres` (provided), `assignment-ingestion` (expected by `run-ingestion.sh`)
- **Environment variables:** see `.env.example` for all config options

## Critical Design Constraints

1. **Resumable ingestion** — must save progress and resume after crash/restart
2. **Rate limit handling** — respect API limits, check response headers
3. **Throughput optimization** — scoring is primarily based on events/minute (60% weight)
4. **The ingestion container must log "ingestion complete"** when done (monitored by `run-ingestion.sh`)
5. **Fully automated** — no manual intervention, must work on a clean Linux machine with only Docker installed
6. **Cursors have a lifecycle** — don't let them get stale
7. The documented API may not be the fastest path — explore alternatives
