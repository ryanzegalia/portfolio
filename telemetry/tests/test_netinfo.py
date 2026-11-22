"""Tests for the IP -> network owner lookup behind the /traffic Network column.

No database and no network: tables are parsed from inline TSV in the
ip2asn format (range_start, range_end, AS_number, country, AS_description).
"""

import pytest

import netinfo

V4_TSV = [
    "1.0.0.0\t1.0.0.255\t13335\tUS\tCLOUDFLARENET\n",
    "1.0.1.0\t1.0.3.255\t0\tNone\tNot routed\n",
    "8.8.8.0\t8.8.8.255\t15169\tUS\tGOOGLE\n",
    "24.0.0.0\t24.0.255.255\t7922\tUS\tCOMCAST-7922\n",
    "43.130.0.0\t43.135.255.255\t132203\tCN\tTENCENT-NET-AP-CN Tencent Building\n",
]
V6_TSV = [
    "2001:4860::\t2001:4860:ffff:ffff:ffff:ffff:ffff:ffff\t15169\tUS\tGOOGLE\n",
    "2600:1700::\t2600:1700:ffff:ffff:ffff:ffff:ffff:ffff\t7018\tUS\tATT-INTERNET4\n",
]


@pytest.fixture(autouse=True)
def tables():
    v4, v4_names = netinfo.parse_table(V4_TSV, 4)
    v6, v6_names = netinfo.parse_table(V6_TSV, 6)
    netinfo.install({4: v4, 6: v6}, {**v4_names, **v6_names})
    netinfo.set_own_ips([])
    yield
    netinfo.install({}, {})
    netinfo.set_own_ips([])


class TestLookup:
    def test_address_inside_a_range(self):
        assert netinfo.lookup("24.0.12.34") == netinfo.Net(7922, "COMCAST-7922")

    def test_range_edges_are_inclusive(self):
        assert netinfo.lookup("8.8.8.0").asn == 15169
        assert netinfo.lookup("8.8.8.255").asn == 15169

    def test_gap_between_ranges_is_unknown(self):
        assert netinfo.lookup("8.8.9.0") is None

    def test_below_the_first_range_is_unknown(self):
        assert netinfo.lookup("0.0.0.1") is None

    def test_not_routed_rows_are_skipped(self):
        assert netinfo.lookup("1.0.2.1") is None

    def test_ipv6(self):
        assert netinfo.lookup("2600:1700:abcd::1").asn == 7018
        assert netinfo.lookup("2001:4860:4860::8888").asn == 15169

    @pytest.mark.parametrize("ip", ["", None, "not-an-ip", "192.0.2.20", "127.0.0.1"])
    def test_blank_bad_and_private_addresses_are_unknown(self, ip):
        assert netinfo.lookup(ip) is None

    def test_before_tables_load_lookup_is_unknown(self):
        netinfo.install({}, {})
        assert netinfo.lookup("24.0.12.34") is None
        assert netinfo.ready() is False


class TestParse:
    def test_overlapping_row_is_dropped_not_trusted(self):
        table, names = netinfo.parse_table(
            [
                "192.0.2.0\t192.0.2.255\t100\tUS\tFIRST\n",
                "192.0.2.128\t192.0.3.255\t200\tUS\tOVERLAP\n",
                "192.0.4.0\t192.0.4.255\t300\tUS\tTHIRD\n",
            ],
            4,
        )
        assert len(table) == 2
        assert 200 not in names

    def test_malformed_lines_are_ignored(self):
        table, _ = netinfo.parse_table(["garbage\n", "1.2.3.4\tx\t5\tUS\tBAD\n", "\n"], 4)
        assert len(table) == 0


class TestOwn:
    @pytest.mark.parametrize("ip", ["192.0.2.237", "192.0.2.5", "127.0.0.1", "2001:db8::1"])
    def test_lan_is_own(self, ip):
        assert netinfo.is_own(ip) is True

    def test_public_address_is_not_own_by_default(self):
        assert netinfo.is_own("24.0.12.34") is False

    def test_servers_public_ip_is_own(self):
        netinfo.set_own_ips(["24.0.12.34"])
        assert netinfo.is_own("24.0.12.34") is True
        assert netinfo.is_own("24.0.12.35") is False

    def test_ipv6_matches_the_home_prefix(self):
        netinfo.set_own_ips(["2600:1700:abcd:ef00::1"])
        assert netinfo.is_own("2600:1700:abcd:ef12::99") is True
        assert netinfo.is_own("2600:1700:abcd:ff00::1") is False

    @pytest.mark.parametrize("ip", ["", None, "junk"])
    def test_blank_or_bad_is_not_own(self, ip):
        assert netinfo.is_own(ip) is False


def test_offline_refresh_does_nothing(monkeypatch):
    monkeypatch.setattr(netinfo, "OFFLINE", True)
    assert netinfo.refresh_tables() is False
    assert netinfo.refresh_own_ip() is False
