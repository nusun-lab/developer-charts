# Domain chart

Discovers the Systems active across every ordered Domain environment in one Helm render.

The chart reads tenant identity and lifecycle policy from the Domain catalog entity, and trusted
Argo CD, router-domain, chart, Schema Registry, Quay, and build configuration from `spec.platform`.
It creates one Domain AppProject and one System-discovery ApplicationSet per ordered environment.
Each ApplicationSet watches `systems/*/environments/<environment>.yaml`; a missing activation file
means that System is inactive in that environment.

By default, Domain admission provisions publisher identities. To admit a Domain without managing publisher clients, set `spec.platform.security.publisherIdentity.enabled: false` in the **trusted platform target**. This omits all publisher-identity resources while retaining the Domain AppProject and System discovery ApplicationSets. Publisher credentials/roles must then be supplied separately when needed. The default is enabled, preserving existing installations.

The same Domain Application owns its privileged publisher boundary without creating a separate
security Application: distinct Apicurio/Microcks Password generators, canonical Secrets,
same-namespace Keycloak projections and `KeycloakOIDCClient` resources, exact-name get-only RBAC,
and conditioned SecretStores. The admitted Domain name determines every privileged name and
selector. Only the selected build namespace can consume the generic local publisher Secrets.

Required values are `metadata`, `spec.platformTarget`, `spec.groupId`, `spec.environments`, and
`spec.platform`. Domain definitions own only `namespaceSuffix`. The chart synthesizes the current
System-chart environment contract by combining those suffixes with
`spec.platform.cluster.routerDomain`.

The build environment must exist, be ordered, and be first. All ordered environments must have
valid definitions. Removing an environment removes only its ApplicationSet through normal Argo CD
pruning.

Tenant annotations locate the Domain repository. `spec.platform.charts.repositoryUrl` and `revision`
locate the trusted chart repository directly. `spec.platform.schemaRegistry`,
`spec.platform.registry`, and `spec.platform.build` pass target-owned runtime policy downstream.

Generated System values use `group:default/domain-maintainers` for tenant ownership. The chart does
not derive per-Domain Backstage group names.

```bash
helm lint charts/domain/environment
helm template tenant-domain charts/domain/environment \
  -f /path/to/merged-domain-and-target-values.yaml
```
