const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {fixture, lint, render, renderFailure, resource} = require('./helpers/helm');
const {repositoryRoot: root} = require('./helpers/paths');

test('one Domain render creates discovery for every ordered environment', () => {
  const values = fixture('split-scm.yaml');
  lint('charts/domain/environment', values);
  const resources = render('charts/domain/environment', values);
  const project = resource(resources, 'AppProject', 'tenant-retail');
  assert.deepEqual(project.spec.sourceRepos, [
    'https://platform-gitea.example/platform-private/developer-charts.git',
    'https://tenant-gitea.example/retail-team/retail-domain.git',
  ]);
  assert.deepEqual(project.spec.destinations, [{
    server: 'https://kubernetes.default.svc', namespace: '*',
  }]);
  assert.deepEqual(project.spec.clusterResourceWhitelist, [
    {group: '', kind: 'Namespace'},
    {group: 'rbac.authorization.k8s.io', kind: 'ClusterRoleBinding'},
  ]);
  assert.deepEqual(resources.filter(item => item.kind === 'Password')
    .map(item => item.metadata.name).sort(), ['retail-apicurio', 'retail-microcks']);
  assert.deepEqual(resources.filter(item => item.kind === 'KeycloakOIDCClient')
    .map(item => item.metadata.name).sort(), ['retail-apicurio', 'retail-microcks']);
  const reader = resource(resources, 'Role', 'retail-publisher-reader');
  assert.deepEqual(reader.rules, [{
    apiGroups: [''], resources: ['secrets'],
    resourceNames: ['retail-apicurio', 'retail-microcks'], verbs: ['get'],
  }]);
  const store = resource(resources, 'ClusterSecretStore', 'retail-publishers');
  assert.deepEqual(store.spec.conditions[0].namespaceSelector.matchLabels, {
    'contract-first-idp.github.io/domain': 'retail',
    'platform.contract-first.io/build-environment': 'true',
  });
  const keycloakStore = resource(resources, 'ClusterSecretStore',
    'retail-keycloak-publishers');
  assert.deepEqual(keycloakStore.spec.conditions[0].namespaceSelector.matchLabels, {
    'kubernetes.io/metadata.name': 'keycloak',
  });
  const applicationSets = resources.filter(item => item.kind === 'ApplicationSet');
  assert.equal(applicationSets.length, values.spec.environments.order.length);
  assert.deepEqual(applicationSets.map(item => item.spec.generators[0].git.files[0].path),
    values.spec.environments.order.map(name => `systems/*/environments/${name}.yaml`));
  assert.equal(applicationSets.every(item =>
    item.spec.template.spec.sources[0].path === 'charts/system/environment'), true);
});

test('Domain project permits dynamically rendered System environment namespaces', () => {
  const destinationServer = 'https://configured-cluster.example';
  const domainValues = fixture('split-scm.yaml');
  domainValues.spec.platform.argocd.destinationServer = destinationServer;
  const domainProject = resource(
    render('charts/domain/environment', domainValues), 'AppProject');

  const systemValues = fixture('nonstandard-lifecycle.yaml');
  systemValues.systemName = 'dynamically-discovered';
  systemValues.environment.namespaceSuffix = '-environment';
  const systemNamespace = resource(
    render('charts/system/environment', systemValues), 'Namespace').metadata.name;

  assert.equal(domainProject.spec.destinations.some(destination =>
    destination.server === destinationServer &&
    (destination.namespace === '*' || destination.namespace === systemNamespace)), true);
});

test('Domain chart reads target configuration from spec.platform', () => {
  const templates = [
    'charts/domain/environment/templates/_helpers.tpl',
    'charts/domain/environment/templates/applicationset.yaml',
    'charts/domain/environment/templates/appproject.yaml',
  ].map(relative => fs.readFileSync(path.join(root, relative), 'utf8')).join('\n');
  assert.match(templates, /\.Values\.spec\.platform/);
  assert.doesNotMatch(templates, /\.Values\.platform/);
  const schema = YAML.parse(fs.readFileSync(
    path.join(root, 'charts/domain/environment/values.schema.json'), 'utf8'));
  assert.ok(schema.properties.spec.required.includes('platform'));
  assert.deepEqual(schema.properties.spec.properties.type, {
    type: 'string',
    const: 'contract-first-idp-target',
  });
  assert.equal(schema.properties.spec.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'platform'), false);
});

test('Domain uses tenant identity and trusted platform inputs', () => {
  const values = fixture('split-scm.yaml');
  const applicationSet = resource(render('charts/domain/environment', values), 'ApplicationSet',
    'retail-stage-systems');
  const generator = applicationSet.spec.generators[0].git;
  const application = applicationSet.spec.template.spec;
  const valuesObject = application.sources[0].helm.valuesObject;

  assert.equal(generator.repoURL,
    'https://tenant-gitea.example/retail-team/retail-domain.git');
  assert.equal(application.sources[0].repoURL,
    'https://platform-gitea.example/platform-private/developer-charts.git');
  assert.equal(application.sources[0].targetRevision, 'v1.0.0');
  assert.equal(application.ignoreDifferences, undefined);
  assert.equal(valuesObject.environment.name, 'stage');
  assert.equal(valuesObject.environment.namespaceSuffix, '-preprod');
  assert.equal(valuesObject.environment.clusterDomain, 'apps.west.example');
  assert.equal(valuesObject.owner, 'group:default/domain-maintainers');
  assert.equal(valuesObject.schemaRegistry.apiUrl,
    'https://registry.example/apis/registry/v3');
  assert.equal(valuesObject.microcks.url, 'https://microcks.example');
  assert.deepEqual(valuesObject.spectralRules, {
    repositoryUrl: 'https://platform-gitea.example/platform-private/spectral-rules.git',
    revision: 'v1.0.0',
    path: 'ruleset.yaml',
  });
  assert.equal(valuesObject.build.environment, 'sandbox');
  assert.equal(valuesObject.build.namespaceSuffix, '-build');
  for (const definition of Object.values(valuesObject.environments.definitions)) {
    assert.equal(definition.clusterDomain, 'apps.west.example');
  }
});

test('Domain rejects incomplete or invalid lifecycle policy', () => {
  const missing = fixture('split-scm.yaml');
  delete missing.spec.environments.definitions.stage;
  assert.match(renderFailure('charts/domain/environment', missing), /ordered environment "stage" has no definition/);

  const invalidOrder = fixture('split-scm.yaml');
  invalidOrder.spec.environments.build = 'stage';
  assert.match(renderFailure('charts/domain/environment', invalidOrder),
    /build environment must be first in the ordered promotion lifecycle/);
});

test('Domain root environment is not required and tenant definitions cannot carry endpoints', () => {
  const values = fixture('split-scm.yaml');
  assert.equal(Object.hasOwn(values, 'environment'), false);
  values.spec.environments.definitions.stage.clusterDomain = 'attacker.example';
  assert.match(
    renderFailure('charts/domain/environment', values),
    /additional propert(?:y|ies).*clusterDomain.*not allowed/i,
  );

  const registryOverride = fixture('split-scm.yaml');
  registryOverride.spec.schemaRegistry = {apiUrl: 'https://attacker.example'};
  assert.match(
    renderFailure('charts/domain/environment', registryOverride),
    /additional propert(?:y|ies).*schemaRegistry.*not allowed/i,
  );
});

test('Domain admission is unchanged with publisher identity disabled', () => {
  const values = fixture('split-scm.yaml');
  const enabled = render('charts/domain/environment', values);
  values.spec.platform.security.publisherIdentity = {enabled: false};
  lint('charts/domain/environment', values);
  const disabled = render('charts/domain/environment', values);
  assert.deepEqual(disabled, enabled.filter(item =>
    item.kind === 'AppProject' || item.kind === 'ApplicationSet'));
});

test('Domain publisher identity is enabled by default and when explicit', () => {
  const values = fixture('split-scm.yaml');
  const baseline = render('charts/domain/environment', values);
  values.spec.platform.security.publisherIdentity = {enabled: true};
  assert.deepEqual(render('charts/domain/environment', values), baseline);
});

test('Domain publisher identity configuration is platform-controlled and boolean', () => {
  const values = fixture('split-scm.yaml');
  values.spec.platform.security.publisherIdentity = {enabled: 'false'};
  assert.match(renderFailure('charts/domain/environment', values), /boolean/i);
  delete values.spec.platform.security.publisherIdentity;
  values.spec.publisherIdentity = {enabled: false};
  assert.match(renderFailure('charts/domain/environment', values), /publisherIdentity.*not allowed/i);
});
