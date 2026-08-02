import {
  Activity,
  Archive,
  Boxes,
  Cloud,
  Container as ContainerIcon,
  Cpu,
  Database,
  Flame,
  FlaskConical,
  Folder,
  Globe,
  HardDrive,
  Laptop,
  Layers,
  Lock,
  Mail,
  Monitor,
  MonitorCog,
  Network,
  Rocket,
  Router,
  ScrollText,
  Server,
  ServerCog,
  Settings,
  Share2,
  Shield,
  Siren,
  Star,
  Terminal,
  Waypoints,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  siAkamai,
  siAlmalinux,
  siAlpinelinux,
  siAnsible,
  siApache,
  siApachecassandra,
  siApachekafka,
  siApachetomcat,
  siArchlinux,
  siArgo,
  siBitbucket,
  siCaddy,
  siCentos,
  siCeph,
  siChef,
  siCisco,
  siClickhouse,
  siCloudflare,
  siContabo,
  siCoolify,
  siDatadog,
  siDebian,
  siDigitalocean,
  siDocker,
  siDotnet,
  siDrone,
  siEclipsemosquitto,
  siElasticsearch,
  siElixir,
  siEnvoyproxy,
  siFedora,
  siFortinet,
  siFreebsd,
  siGit,
  siGitea,
  siGithub,
  siGitlab,
  siGo,
  siGooglecloud,
  siGrafana,
  siGraylog,
  siHelm,
  siHetzner,
  siHomeassistant,
  siIcinga,
  siInfluxdb,
  siJellyfin,
  siJenkins,
  siK3s,
  siKalilinux,
  siKeycloak,
  siKubernetes,
  siLetsencrypt,
  siLinux,
  siLinuxcontainers,
  siMacos,
  siMariadb,
  siMikrotik,
  siMinio,
  siMongodb,
  siMysql,
  siN8n,
  siNatsdotio,
  siNetdata,
  siNextcloud,
  siNginx,
  siNixos,
  siNodedotjs,
  siOllama,
  siOpenjdk,
  siOpenmediavault,
  siOpensearch,
  siOpensuse,
  siOpentofu,
  siOpenvpn,
  siOpenwrt,
  siOpnsense,
  siOvh,
  siPacker,
  siPfsense,
  siPhp,
  siPihole,
  siPlex,
  siPodman,
  siPortainer,
  siPostgresql,
  siPrometheus,
  siProxmox,
  siPulumi,
  siPuppet,
  siPython,
  siQnap,
  siRabbitmq,
  siRancher,
  siRaspberrypi,
  siRedhat,
  siRedhatopenshift,
  siRedis,
  siRockylinux,
  siRuby,
  siRust,
  siSaltproject,
  siScaleway,
  siSplunk,
  siSqlite,
  siSupabase,
  siSynology,
  siTailscale,
  siTerraform,
  siTraefikproxy,
  siTruenas,
  siUbiquiti,
  siUbuntu,
  siUnraid,
  siUptimekuma,
  siVagrant,
  siVault,
  siVaultwarden,
  siVeeam,
  siVmware,
  siVultr,
  siWireguard,
  siWordpress,
  siZerotier,
  type SimpleIcon,
} from "simple-icons";

/**
 * Ícones de conexão: o que a máquina é (SO/provedor) e o que roda nela.
 *
 * Três origens, todas monocromáticas e pintadas com a cor da conexão —
 * genéricos do lucide (linha), marcas do simple-icons (sólidas) e alguns
 * desenhados aqui: Windows, AWS, Azure e Oracle saíram do simple-icons por
 * questão de marca registrada.
 */

interface PathIcon {
  title: string;
  path: string;
}

const CUSTOM: Record<string, PathIcon> = {
  windows: {
    title: "Windows Server",
    path: "M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801",
  },
  iis: {
    title: "IIS",
    path: "M0 3.449 9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801",
  },
  aws: {
    title: "AWS",
    path: "M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576a.35.35 0 0 1 .056.184c0 .08-.048.16-.152.24l-.503.336a.38.38 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.5 2.5 0 0 1-.287-.375 6 6 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.671 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2 2 0 0 1-.28.104.5.5 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.6.6 0 0 1 .224-.167 4.6 4.6 0 0 1 1.005-.36 4.85 4.85 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.44.43.663 1.085.663 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51a1.27 1.27 0 0 0 .272-.512c.047-.191.08-.423.08-.694v-.335a6.7 6.7 0 0 0-.735-.136 6 6 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.294.846.191.2.47.296.838.296m6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.4 1.4 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.152-.312a.55.55 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1 1 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.5.5 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.6.6 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.78.78 0 0 0-.215-.559c-.144-.151-.415-.287-.806-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.9 1.9 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.7.7 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.65 3.65 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926a2.2 2.2 0 0 1-.583.703c-.25.2-.55.343-.894.447-.36.111-.734.167-1.142.167M21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607m1.086-1.235c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994",
  },
  azure: {
    title: "Azure",
    path: "M8.28 2.4 3.2 16.32l3.94.02L2.4 21.6h9.36L8.28 2.4zm2.52 0 3.4 9.53-5.02 9.67H21.6L10.8 2.4z",
  },
  oracle: {
    title: "Oracle",
    path: "M16.412 4.412h-8.82a7.588 7.588 0 0 0 0 15.176h8.82a7.588 7.588 0 0 0 0-15.176m-.193 12.914H7.786a5.325 5.325 0 0 1 0-10.652h8.433a5.326 5.326 0 1 1 0 10.652",
  },
};

/** Marcas do simple-icons, pela chave gravada no banco. */
const BRANDS: Record<string, SimpleIcon> = {
  // ------------------------------------------------ sistemas operacionais
  ubuntu: siUbuntu,
  debian: siDebian,
  redhat: siRedhat,
  centos: siCentos,
  rocky: siRockylinux,
  alma: siAlmalinux,
  fedora: siFedora,
  alpine: siAlpinelinux,
  arch: siArchlinux,
  opensuse: siOpensuse,
  kali: siKalilinux,
  nixos: siNixos,
  linux: siLinux,
  freebsd: siFreebsd,
  macos: siMacos,
  raspberry: siRaspberrypi,
  openwrt: siOpenwrt,
  // ------------------------------------------------- cloud e provedores
  gcp: siGooglecloud,
  digitalocean: siDigitalocean,
  hetzner: siHetzner,
  akamai: siAkamai, // Linode
  vultr: siVultr,
  ovh: siOvh,
  contabo: siContabo,
  scaleway: siScaleway,
  cloudflare: siCloudflare,
  // -------------------------------------------- containers e virtualização
  docker: siDocker,
  kubernetes: siKubernetes,
  podman: siPodman,
  k3s: siK3s,
  lxc: siLinuxcontainers,
  portainer: siPortainer,
  rancher: siRancher,
  openshift: siRedhatopenshift,
  proxmox: siProxmox,
  vmware: siVmware,
  helm: siHelm,
  // ------------------------------------------------------ devops e IaC
  ansible: siAnsible,
  terraform: siTerraform,
  opentofu: siOpentofu,
  puppet: siPuppet,
  chef: siChef,
  salt: siSaltproject,
  vagrant: siVagrant,
  packer: siPacker,
  pulumi: siPulumi,
  // -------------------------------------------------------- CI/CD e SCM
  jenkins: siJenkins,
  gitlab: siGitlab,
  github: siGithub,
  gitea: siGitea,
  argo: siArgo,
  bitbucket: siBitbucket,
  drone: siDrone,
  git: siGit,
  coolify: siCoolify,
  // ----------------------------------------------------------- web/proxy
  nginx: siNginx,
  apache: siApache,
  caddy: siCaddy,
  traefik: siTraefikproxy,
  tomcat: siApachetomcat,
  envoy: siEnvoyproxy,
  wordpress: siWordpress,
  // ------------------------------------------------------------- bancos
  postgres: siPostgresql,
  mysql: siMysql,
  mariadb: siMariadb,
  mongodb: siMongodb,
  redis: siRedis,
  elastic: siElasticsearch,
  opensearch: siOpensearch,
  clickhouse: siClickhouse,
  cassandra: siApachecassandra,
  influxdb: siInfluxdb,
  sqlite: siSqlite,
  supabase: siSupabase,
  // --------------------------------------------------------- mensageria
  rabbitmq: siRabbitmq,
  kafka: siApachekafka,
  nats: siNatsdotio,
  mqtt: siEclipsemosquitto,
  // ------------------------------------------------------ monitoramento
  prometheus: siPrometheus,
  grafana: siGrafana,
  netdata: siNetdata,
  datadog: siDatadog,
  uptimekuma: siUptimekuma,
  splunk: siSplunk,
  graylog: siGraylog,
  icinga: siIcinga,
  // ---------------------------------------------- rede, VPN e segurança
  wireguard: siWireguard,
  openvpn: siOpenvpn,
  tailscale: siTailscale,
  zerotier: siZerotier,
  pfsense: siPfsense,
  opnsense: siOpnsense,
  mikrotik: siMikrotik,
  cisco: siCisco,
  ubiquiti: siUbiquiti,
  fortinet: siFortinet,
  vault: siVault,
  keycloak: siKeycloak,
  letsencrypt: siLetsencrypt,
  // ----------------------------------------------------------- runtimes
  node: siNodedotjs,
  python: siPython,
  java: siOpenjdk,
  go: siGo,
  php: siPhp,
  dotnet: siDotnet,
  ruby: siRuby,
  rust: siRust,
  elixir: siElixir,
  // --------------------------------------------------- storage e backup
  minio: siMinio,
  ceph: siCeph,
  truenas: siTruenas,
  nextcloud: siNextcloud,
  veeam: siVeeam,
  synology: siSynology,
  qnap: siQnap,
  openmediavault: siOpenmediavault,
  unraid: siUnraid,
  // ------------------------------------------------------- self-hosted
  homeassistant: siHomeassistant,
  jellyfin: siJellyfin,
  plex: siPlex,
  vaultwarden: siVaultwarden,
  n8n: siN8n,
  pihole: siPihole,
  ollama: siOllama,
};

/**
 * Genéricos (lucide). Muita gente prefere categoria a logo — e com a cor
 * customizada é o jeito mais rápido de separar prod/staging/dev.
 */
const GENERIC: Record<string, LucideIcon> = {
  server: Server,
  rack: ServerCog,
  vm: MonitorCog,
  container: ContainerIcon,
  database: Database,
  firewall: Shield,
  loadbalancer: Waypoints,
  router: Router,
  switch: Network,
  cloud: Cloud,
  terminal: Terminal,
  desktop: Monitor,
  laptop: Laptop,
  lock: Lock,
  gear: Settings,
  globe: Globe,
  folder: Folder,
  star: Star,
  layers: Layers,
  boxes: Boxes,
  cpu: Cpu,
  "hard-drive": HardDrive,
  rocket: Rocket,
  flask: FlaskConical,
  wrench: Wrench,
  zap: Zap,
  mail: Mail,
  // Marcas sem ícone livre disponível: categoria + rótulo dão o recado.
  haproxy: Waypoints,
  zabbix: Activity,
  nagios: Siren,
  loki: ScrollText,
  samba: Share2,
  restic: Archive,
  sqlserver: Database,
  valkey: Flame,
};

/** Rótulos dos genéricos que não são óbvios pela chave. */
const GENERIC_LABELS: Record<string, string> = {
  server: "Servidor",
  rack: "Rack",
  vm: "Máquina virtual",
  container: "Container",
  database: "Banco de dados",
  firewall: "Firewall",
  loadbalancer: "Load balancer",
  router: "Roteador",
  switch: "Switch",
  cloud: "Nuvem",
  terminal: "Terminal",
  desktop: "Desktop",
  laptop: "Laptop",
  lock: "Cadeado",
  gear: "Engrenagem",
  globe: "Globo",
  folder: "Pasta / grupo",
  star: "Favorito",
  layers: "Camadas",
  boxes: "Caixas",
  cpu: "CPU",
  "hard-drive": "Disco",
  rocket: "Deploy",
  flask: "Staging / teste",
  wrench: "Manutenção",
  zap: "Energia",
  mail: "E-mail",
  haproxy: "HAProxy",
  zabbix: "Zabbix",
  nagios: "Nagios",
  loki: "Loki",
  samba: "Samba",
  restic: "Restic",
  sqlserver: "SQL Server",
  valkey: "Valkey",
};

/** Grupos do seletor de ícone, na ordem em que aparecem. */
export const ICON_GROUPS: { label: string; names: string[] }[] = [
  {
    label: "Genéricos",
    names: [
      "server", "rack", "vm", "container", "database", "firewall", "loadbalancer",
      "router", "switch", "cloud", "terminal", "desktop", "laptop", "lock",
      "gear", "globe", "folder", "star", "rocket", "flask", "wrench", "zap",
      "layers", "boxes", "cpu", "hard-drive", "mail",
    ],
  },
  {
    label: "Sistemas operacionais",
    names: [
      "ubuntu", "debian", "redhat", "centos", "rocky", "alma", "fedora", "alpine",
      "arch", "opensuse", "kali", "nixos", "linux", "freebsd", "windows", "macos",
      "raspberry", "openwrt",
    ],
  },
  {
    label: "Cloud e hosting",
    names: [
      "aws", "azure", "gcp", "oracle", "digitalocean", "hetzner", "akamai",
      "vultr", "ovh", "contabo", "scaleway", "cloudflare",
    ],
  },
  {
    label: "Containers e virtualização",
    names: [
      "docker", "kubernetes", "podman", "k3s", "lxc", "portainer", "rancher",
      "openshift", "proxmox", "vmware", "helm",
    ],
  },
  {
    label: "DevOps e IaC",
    names: [
      "ansible", "terraform", "opentofu", "puppet", "chef", "salt", "vagrant",
      "packer", "pulumi",
    ],
  },
  {
    label: "CI/CD e repositórios",
    names: ["jenkins", "gitlab", "github", "gitea", "argo", "bitbucket", "drone", "git", "coolify"],
  },
  {
    label: "Web e proxy",
    names: ["nginx", "apache", "caddy", "traefik", "haproxy", "tomcat", "iis", "envoy", "wordpress"],
  },
  {
    label: "Bancos de dados",
    names: [
      "postgres", "mysql", "mariadb", "mongodb", "redis", "valkey", "elastic",
      "opensearch", "clickhouse", "cassandra", "sqlserver", "influxdb", "sqlite",
      "supabase",
    ],
  },
  {
    label: "Mensageria",
    names: ["rabbitmq", "kafka", "nats", "mqtt"],
  },
  {
    label: "Monitoramento",
    names: [
      "zabbix", "prometheus", "grafana", "loki", "nagios", "netdata", "datadog",
      "uptimekuma", "splunk", "graylog", "icinga",
    ],
  },
  {
    label: "Rede, VPN e segurança",
    names: [
      "wireguard", "openvpn", "tailscale", "zerotier", "pfsense", "opnsense",
      "mikrotik", "cisco", "ubiquiti", "fortinet", "vault", "keycloak", "letsencrypt",
    ],
  },
  {
    label: "Runtimes",
    names: ["node", "python", "java", "go", "php", "dotnet", "ruby", "rust", "elixir"],
  },
  {
    label: "Storage e backup",
    names: [
      "minio", "ceph", "truenas", "nextcloud", "samba", "restic", "veeam",
      "synology", "qnap", "openmediavault", "unraid",
    ],
  },
  {
    label: "Self-hosted",
    names: ["homeassistant", "jellyfin", "plex", "vaultwarden", "n8n", "pihole", "ollama"],
  },
];

export const ICON_NAMES = ICON_GROUPS.flatMap((g) => g.names);

export function iconLabel(name: string): string {
  return (
    BRANDS[name]?.title ?? CUSTOM[name]?.title ?? GENERIC_LABELS[name] ?? name
  );
}

export function ConnIcon({
  name,
  size = 15,
  color,
}: {
  name: string;
  size?: number;
  color?: string;
}) {
  const brand = BRANDS[name];
  const custom = CUSTOM[name];

  if (brand || custom) {
    const path = brand ? brand.path : custom.path;
    const title = brand ? brand.title : custom.title;
    return (
      <svg
        role="img"
        aria-label={title}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={color ?? "currentColor"}
        style={{ flex: "none" }}
      >
        <path d={path} />
      </svg>
    );
  }

  const Cmp = GENERIC[name] ?? Server;
  return <Cmp size={size} color={color} strokeWidth={2} style={{ flex: "none" }} />;
}
