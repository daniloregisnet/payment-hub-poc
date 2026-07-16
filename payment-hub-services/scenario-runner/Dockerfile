FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY main.go .
RUN go mod init scenario-runner
RUN go build -o scenario-runner main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/scenario-runner .
EXPOSE 8004
CMD ["./scenario-runner"]
