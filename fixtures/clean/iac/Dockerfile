FROM alpine:3.20
RUN adduser -D -u 10001 app
USER 10001
HEALTHCHECK --interval=30s --timeout=3s CMD ["true"]
CMD ["sleep", "infinity"]
