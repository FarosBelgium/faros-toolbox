// The apps the toolbox manages. Each one publishes its installers as GitHub Releases,
// built by electron-builder, with a latest*.yml feed per OS next to them:
//   https://github.com/<owner>/<repo>/releases/latest/download/latest-linux.yml
// Those URLs are plain downloads (no GitHub API), so there is no API rate limit.
//
// Per app:
//   id           also the Debian package name and the .desktop file name (Linux)
//   productName  electron-builder productName: /opt/<productName>, <productName>.app,
//                %LOCALAPPDATA%\Programs\<productName>\<productName>.exe
//   executable   Linux executable name inside /opt/<productName>
//   appId        electron-builder appId (Windows registry key, macOS bundle id)

const APPS = [
  {
    id: 'shellfish',
    name: 'Shellfish',
    productName: 'Shellfish',
    executable: 'shellfish',
    appId: 'be.faros.shellfish',
    description: 'SSH terminal and dual-pane SFTP client for saved hosts',
    owner: 'FarosBelgium',
    repo: 'shellfish',
    icon: 'assets/apps/shellfish.png',
  },
  {
    id: 'edbmax',
    name: 'EDB*Max',
    productName: 'EDBMax',
    executable: 'edbmax',
    appId: 'be.faros.edbmax',
    description: 'Run SQL files and queries on saved EDB Postgres connections with EDB*Plus',
    owner: 'FarosBelgium',
    repo: 'edbmax',
    icon: 'assets/apps/edbmax.png',
  },
  {
    id: 'vpnmaster',
    name: 'VPNMaster',
    productName: 'VPNMaster',
    executable: 'vpnmaster',
    appId: 'be.faros.vpnmaster',
    description: 'Saved Cisco Secure Client VPNs, connect in one click (also SSO logins)',
    owner: 'FarosBelgium',
    repo: 'VpnMaster',
    icon: 'assets/apps/vpnmaster.png',
  },
];

function releasesPage(app, version) {
  const base = `https://github.com/${app.owner}/${app.repo}/releases`;
  return version ? `${base}/tag/v${version}` : `${base}/latest`;
}

module.exports = { APPS, releasesPage };
