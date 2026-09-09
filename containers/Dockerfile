ARG BASE_IMAGE=quay.io/fedora/fedora:44
FROM ${BASE_IMAGE}
COPY node/ /opt/node/
ENV PATH=/opt/node/bin:$PATH
COPY bootstrap.sh /tmp/bootstrap.sh
RUN bash /tmp/bootstrap.sh
ENV HOME=/home/validator
WORKDIR /workspace
