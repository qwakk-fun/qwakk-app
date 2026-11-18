// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Qwakk (QWAKK)
/// @author Qwakk
/// @notice Qwakk's meme token on the QoreChain Diana testnet. A plain,
///         fixed-supply ERC-20: 1,000,000,000 QWAKK with 6 decimals, minted
///         once to the deployer in the constructor.
///
///         There is no owner or admin role, no mint or burn function, no fee
///         or tax on transfers, no pause and no blocklist. Nothing about the
///         token can change after deployment.
///
/// @dev    Follows the OpenZeppelin Contracts v5 ERC-20 behaviour (the
///         IERC6093 custom errors, `type(uint256).max` as an infinite
///         allowance that is never decreased, and no `Approval` event when an
///         allowance is spent), written out without inheritance so the whole
///         token reads in one file.
///
///         QoreChain registers an ERC-20 as a bank denom with
///         `MsgRegisterERC20` (cosmos/evm v0.6.3, x/erc20/keeper/proposals.go).
///         Registration reads `name()`, `symbol()` and `decimals()` from the
///         erc20 module address, so all three are plain view functions here.
///         Converting to and from the bank coin (x/erc20/keeper/convert.go and
///         msg_server.go) calls `transfer` and then requires the balance to
///         move by exactly the amount, so a transfer here never takes a fee.
contract QwakkToken {
    /// @notice The token name. The registered bank denom's display unit is
    ///         derived from it (SanitizeERC20Name("Qwakk") is "Qwakk").
    string public constant name = "Qwakk";
    /// @notice The token symbol, copied into the bank denom metadata.
    string public constant symbol = "QWAKK";
    /// @notice 6 decimals, the same scale as QOR's uqor.
    uint8 public constant decimals = 6;
    /// @notice 1,000,000,000 QWAKK in base units (1e9 * 1e6 = 1e15).
    uint256 public constant totalSupply = 1_000_000_000 * 10 ** 6;

    mapping(address account => uint256) public balanceOf;
    mapping(address account => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InvalidSender(address sender);
    error ERC20InvalidReceiver(address receiver);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);

    /// @notice Mints the whole supply to the deployer. This is the only mint.
    constructor() {
        balanceOf[msg.sender] = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 current = allowance[from][msg.sender];
        if (current != type(uint256).max) {
            if (current < value) revert ERC20InsufficientAllowance(msg.sender, current, value);
            unchecked {
                allowance[from][msg.sender] = current - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        uint256 fromBalance = balanceOf[from];
        if (fromBalance < value) revert ERC20InsufficientBalance(from, fromBalance, value);
        unchecked {
            // fromBalance >= value, and no balance can exceed totalSupply, so neither line can wrap.
            balanceOf[from] = fromBalance - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }

    function _approve(address owner, address spender, uint256 value) private {
        if (owner == address(0)) revert ERC20InvalidApprover(address(0));
        if (spender == address(0)) revert ERC20InvalidSpender(address(0));
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
