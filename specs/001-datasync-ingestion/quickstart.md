# Quickstart: DataSync Event Ingestion System

## Prerequisites

- Docker and Docker Compose installed
- API key set in docker-compose.yml (or `.env` file)

## Run

```bash
sh run-ingestion.sh
```

That's it. The script:
1. Builds the ingestion service Docker image
2. Starts PostgreSQL and the ingestion service
3. Monitors progress by polling `SELECT COUNT(*) FROM ingested_events`
4. Exits when container logs contain "ingestion complete"

## Monitor

```bash
# Follow structured logs
docker logs -f assignment-ingestion

# Check event count directly
docker exec assignment-postgres psql -U postgres -d ingestion -t -c "SELECT COUNT(*) FROM ingested_events;"

# Check container health
docker inspect --format='{{.State.Health.Status}}' assignment-ingestion
```

## After Crash / Kill

```bash
# Just re-run — the system detects prior checkpoints and resumes
sh run-ingestion.sh
```

## Verify Completion

```bash
# Should return 3000000
docker exec assignment-postgres psql -U postgres -d ingestion -t -c "SELECT COUNT(*) FROM ingested_events;"

# Should return 3000000 (no duplicates)
docker exec assignment-postgres psql -U postgres -d ingestion -t -c "SELECT COUNT(DISTINCT id) FROM ingested_events;"
```

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@postgres:5432/ingestion` | PostgreSQL connection string |
| `API_BASE_URL` | `http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com` | DataSync API base URL |
| `API_KEY` | *(required)* | DataSync API key |
| `BATCH_SIZE` | `5000` | Events per DB insert batch (matches API page size) |
| `BUFFER_CAPACITY` | `3` | Max pages buffered between fetch and insert |
| `LOG_INTERVAL_MS` | `10000` | Progress log interval in milliseconds |
